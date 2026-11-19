import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import pg from 'pg';
import type { Activity, Entity, Item, Tag, User } from './shared/contracts.js';
import { profileWithMemberships } from './domain.js';
import { dashboardCards, readStatistics, type MapUser } from './community-reads.js';
import type { Statistics } from './shared/contracts.js';

export interface DatabaseState {
  users: User[]; entities: Entity[]; tags: Tag[]; items: Item[]; activities: Activity[];
  telegramUsers: Record<string, string>;
  userPublicIds: Record<string, number>;
  sessions: Record<string, { userId: string; expiresAt: string; source?: 'demo' | 'telegram' }>;
  authRequests: Record<string, {
    browserHash: string; expiresAt: string; status: 'pending' | 'approved' | 'rejected' | 'denied'; userId?: string;
    displayCode?: string; telegramId?: string; promptMessageId?: number;
    origin?: string; requestedAt?: string; decidedAt?: string;
  }>;
}
export interface Repository {
  readonly revision?: number;
  readSession?(key: string, at: number, withProfile: boolean): Promise<SessionPrincipal | undefined>;
  authRequest?(id: string): Promise<DatabaseState['authRequests'][string] | undefined>;
  readPage?<T>(page: CommunityPage, fn: (state: DatabaseState) => T, at: Date): Promise<T>;
  statistics?(includeDrafts: boolean): Promise<Statistics>;
  geographyUsers?(): Promise<MapUser[]>;
  read<T>(fn: (state: DatabaseState) => T | Promise<T>): Promise<T>;
  write<T>(fn: (state: DatabaseState) => T | Promise<T>): Promise<T>;
  close(): Promise<void>;
  ping?(): Promise<void>;
}
export type CommunityPage = 'tags' | 'items' | 'dashboard';
type SessionPrincipal = { user: User; telegramId?: string; source?: 'demo' | 'telegram' };
export function emptyState(): DatabaseState {
  return { users: [], entities: [], tags: [], items: [], activities: [], telegramUsers: {}, userPublicIds: {}, sessions: {}, authRequests: {} };
}

/** A serialized unit of work. Failed callbacks never publish their mutations. */
export class MemoryRepository implements Repository {
  revision = 0;
  protected state: DatabaseState;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(initial: DatabaseState = emptyState(), private file?: string) {
    this.state = { ...structuredClone(initial), userPublicIds: structuredClone(initial.userPublicIds ?? {}) };
  }
  async read<T>(fn: (state: DatabaseState) => T | Promise<T>): Promise<T> { await this.queue; return fn(structuredClone(this.state)); }
  async write<T>(fn: (state: DatabaseState) => T | Promise<T>): Promise<T> {
    const operation = this.queue.then(async () => {
      const draft = structuredClone(this.state);
      const result = await fn(draft);
      if (this.file) {
        await mkdir(dirname(this.file), { recursive: true });
        await writeFile(`${this.file}.tmp`, JSON.stringify(draft), 'utf8');
        await rename(`${this.file}.tmp`, this.file);
      }
      this.state = draft;
      this.revision++;
      return structuredClone(result);
    });
    this.queue = operation.catch(() => undefined);
    return operation;
  }
  async close() { await this.queue; }
  static async persistent(file: string, seed: () => DatabaseState) {
    let initial: DatabaseState;
    try { initial = JSON.parse(await readFile(file, 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; initial = seed(); }
    return new MemoryRepository(initial, file);
  }
}

const migration = `
CREATE TABLE IF NOT EXISTS klan_users (id text PRIMARY KEY, data jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS klan_entities (id text PRIMARY KEY, kind text NOT NULL CHECK (kind IN ('events','teams','challenges','news','feedback','books','rules')), data jsonb NOT NULL);
CREATE INDEX IF NOT EXISTS klan_entities_kind ON klan_entities(kind);
CREATE INDEX IF NOT EXISTS klan_entities_data ON klan_entities USING gin(data);
CREATE TABLE IF NOT EXISTS klan_tags (id text PRIMARY KEY, data jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS klan_items (id text PRIMARY KEY, data jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS klan_activities (id text PRIMARY KEY, data jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS klan_auth (kind text NOT NULL, id text NOT NULL, data jsonb NOT NULL, PRIMARY KEY(kind,id));
`;
const tables = { users: 'klan_users', entities: 'klan_entities', tags: 'klan_tags', items: 'klan_items', activities: 'klan_activities' } as const;
const authKeys = ['telegramUsers', 'sessions', 'authRequests', 'userPublicIds'] as const;

/** PostgreSQL adapter. Advisory transaction lock protects cross-entity invariants across API instances. */
export class PostgresRepository implements Repository {
  revision = 0;
  private pool: pg.Pool;
  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString, max: 4, connectionTimeoutMillis: 5000, query_timeout: 10000 });
    this.pool.on('error', error => {
      // pg removes failed idle clients before emitting this event. Keep the API
      // alive so a later request can reconnect; the attached client can contain secrets.
      const code = (error as NodeJS.ErrnoException).code;
      const safeCode = typeof code === 'string' && /^[A-Z0-9_]{1,32}$/.test(code) ? code : 'UNKNOWN';
      console.error(`PostgreSQL idle connection failed (${safeCode}); the pool will reconnect when needed.`);
    });
  }
  async ping() { await this.pool.query('SELECT 1'); }
  async geographyUsers(): Promise<MapUser[]> {
    const result = await this.pool.query<MapUser>(`SELECT u.id, p.* FROM klan_users u,
      jsonb_to_record(u.data) AS p(name text, username text, callsign text, bio text, location jsonb,
        interests jsonb, facts jsonb, achievements jsonb, tags jsonb, "joinedAt" text, "publicId" double precision,
        initials text, color text) ORDER BY u.id`);
    return result.rows;
  }
  statistics(includeDrafts: boolean) {
    return this.snapshot(db => readStatistics(db, includeDrafts));
  }
  async readPage<T>(page: CommunityPage, fn: (state: DatabaseState) => T, at: Date): Promise<T> {
    const state = emptyState();
    if (page === 'tags' || page === 'items') {
      const result = await this.pool.query(`SELECT data FROM ${tables[page]} ORDER BY id`);
      state[page] = result.rows.map(row => row.data);
      return fn(state);
    }
    return this.snapshot(async db => {
      state.users = (await db.query("SELECT data - ARRAY['historicalImport','communityImport'] AS profile FROM klan_users ORDER BY id")).rows.map(r => r.profile);
      state.activities = (await db.query('SELECT data FROM klan_activities ORDER BY id')).rows.map(r => r.data);
      // Discard daily results for the overview. Fetch complete documents only for the displayed cards.
      state.entities = (await db.query("SELECT data - ARRAY['results','pendingResults','historicalImport','content'] AS entity FROM klan_entities ORDER BY id")).rows.map(r => r.entity);
      const cards = dashboardCards(state.entities, at);
      const ids = [...cards.events, ...cards.challenges, ...cards.teams].map(e => e.id);
      if (ids.length) {
        const full = await db.query<{id: string; data: Entity}>('SELECT id, data FROM klan_entities WHERE id = ANY($1::text[])', [ids]);
        const byId = new Map(full.rows.map(row => [row.id, row.data]));
        state.entities = state.entities.map(e => byId.get(e.id) ?? e);
      }
      return fn(state);
    });
  }
  async readSession(key: string, at: number, withProfile: boolean): Promise<SessionPrincipal | undefined> {
    const result = await this.pool.query(`
      SELECT u.data - ARRAY['communityImport','historicalImport'] AS profile, s.data->>'source' AS source,
        (SELECT id FROM klan_auth WHERE kind = 'telegramUsers' AND data = to_jsonb(u.id) LIMIT 1) AS telegram,
        CASE WHEN $3 THEN (
          SELECT jsonb_agg(jsonb_build_object('kind', e.kind, 'team', CASE WHEN e.kind = 'teams' THEN
            jsonb_build_object('id', e.id, 'title', e.data->'title', 'description', e.data->'description',
              'memberCount', (SELECT count(DISTINCT (p#>>'{user,id}')) FROM jsonb_array_elements(e.data->'participants') p)) END)
            ORDER BY e.id)
          FROM klan_entities e
          WHERE (e.kind IN ('events','challenges','teams') AND (e.kind <> 'teams' OR e.data->>'status' = 'active')
            AND e.data @> jsonb_build_object('participants', jsonb_build_array(jsonb_build_object('user', jsonb_build_object('id', u.id)))))
            OR (e.kind = 'books' AND e.data @> jsonb_build_object('readers', jsonb_build_array(jsonb_build_object('id', u.id))))
        ) END AS memberships
      FROM klan_auth s JOIN klan_users u ON u.id = s.data->>'userId'
      WHERE s.kind = 'sessions' AND s.id = $1 AND (s.data->>'expiresAt')::timestamptz > $2::timestamptz`,
      [key, new Date(at).toISOString(), withProfile]);
    const row = result.rows[0];
    if (!row) return undefined;
    let user: User = row.profile;
    if (withProfile) {
      const memberships: { kind: keyof User['stats'] | 'teams'; team?: NonNullable<User['activeTeams']>[number] }[] = row.memberships ?? [];
      const stats = { events: 0, challenges: 0, books: 0 };
      const teams: NonNullable<User['activeTeams']> = [];
      for (const entry of memberships) {
        if (entry.kind === 'teams') { if (entry.team) teams.push(entry.team); }
        else stats[entry.kind]++;
      }
      user = profileWithMemberships(user, teams, stats);
    }
    return { user, telegramId: row.telegram ?? undefined, source: row.source ?? undefined };
  }
  async authRequest(id: string): Promise<DatabaseState['authRequests'][string] | undefined> {
    const result = await this.pool.query("SELECT data FROM klan_auth WHERE kind = 'authRequests' AND id = $1", [id]);
    return result.rows[0]?.data;
  }
  async migrate() {
    const connection = await this.pool.connect();
    try {
      await connection.query('BEGIN');
      await connection.query('SELECT pg_advisory_xact_lock(54652601)');
      await connection.query('CREATE TABLE IF NOT EXISTS klan_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
      const done = await connection.query('SELECT version FROM klan_migrations WHERE version = 1');
      if (!done.rowCount) { await connection.query(migration); await connection.query('INSERT INTO klan_migrations(version) VALUES(1)'); }
      await connection.query('COMMIT');
    } catch (error) { await connection.query('ROLLBACK'); throw error; }
    finally { connection.release(); }
  }
  private async load(connection: pg.PoolClient): Promise<DatabaseState> {
    const state = emptyState();
    for (const [collection, table] of Object.entries(tables)) {
      const result = await connection.query(`SELECT data FROM ${table} ORDER BY id`);
      (state as unknown as Record<string, unknown>)[collection] = result.rows.map(row => row.data);
    }
    const auth = await connection.query('SELECT kind,id,data FROM klan_auth');
    for (const row of auth.rows) if (authKeys.includes(row.kind)) (state[row.kind as typeof authKeys[number]] as Record<string, unknown>)[row.id] = row.data;
    return state;
  }
  private async save(connection: pg.PoolClient, before: DatabaseState, after: DatabaseState) {
    let communityChanged = false;
    for (const [collection, table] of Object.entries(tables) as [keyof typeof tables, string][]) {
      const previous = new Map(before[collection].map(row => [row.id, JSON.stringify(row)]));
      const retained = new Set<string>();
      for (const row of after[collection]) {
        retained.add(row.id);
        if (previous.get(row.id) === JSON.stringify(row)) continue;
        communityChanged = true;
        if (collection === 'entities') await connection.query(`INSERT INTO ${table}(id,kind,data) VALUES($1,$2,$3) ON CONFLICT(id) DO UPDATE SET kind=EXCLUDED.kind,data=EXCLUDED.data`, [row.id, (row as Entity).type, row]);
        else await connection.query(`INSERT INTO ${table}(id,data) VALUES($1,$2) ON CONFLICT(id) DO UPDATE SET data=EXCLUDED.data`, [row.id, row]);
      }
      for (const id of previous.keys()) if (!retained.has(id)) {
        await connection.query(`DELETE FROM ${table} WHERE id=$1`, [id]);
        communityChanged = true;
      }
    }
    for (const kind of authKeys) {
      for (const [id, data] of Object.entries(after[kind])) if (JSON.stringify(before[kind][id]) !== JSON.stringify(data)) {
        await connection.query('INSERT INTO klan_auth(kind,id,data) VALUES($1,$2,$3::jsonb) ON CONFLICT(kind,id) DO UPDATE SET data=EXCLUDED.data', [kind, id, JSON.stringify(data)]);
      }
      for (const id of Object.keys(before[kind])) if (!(id in after[kind])) await connection.query('DELETE FROM klan_auth WHERE kind=$1 AND id=$2', [kind, id]);
    }
    return communityChanged;
  }
  async read<T>(fn: (state: DatabaseState) => T | Promise<T>): Promise<T> {
    return this.snapshot(async db => fn(await this.load(db)));
  }
  private async snapshot<T>(fn: (db: pg.PoolClient) => Promise<T>): Promise<T> {
    const connection = await this.pool.connect();
    try {
      await connection.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const result = await fn(connection);
      await connection.query('COMMIT');
      return result;
    } catch (error) { await connection.query('ROLLBACK'); throw error; }
    finally { connection.release(); }
  }
  async write<T>(fn: (state: DatabaseState) => T | Promise<T>): Promise<T> {
    const connection = await this.pool.connect();
    try {
      await connection.query('BEGIN');
      await connection.query('SELECT pg_advisory_xact_lock(54652602)');
      const state = await this.load(connection);
      const before = structuredClone(state);
      const result = await fn(state);
      const communityChanged = await this.save(connection, before, state);
      await connection.query('COMMIT');
      if (communityChanged) this.revision++;
      return result;
    } catch (error) { await connection.query('ROLLBACK'); throw error; }
    finally { connection.release(); }
  }
  async close() { await this.pool.end(); }
}
