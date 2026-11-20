import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import pg from 'pg';
import { analyticsState } from './analytics-reads.js';
import { HttpError, notFound } from './errors.js';
import { migratedGoal, upgradeChallengeGoal } from './challenge-goals.js';
import { isDeploymentAdmin, reconcileDeploymentAdmins } from './deployment-admins.js';
import { cardProjection, readProjections } from './read-projections.js';
import { activeTeamUserIds, entityCardSelect, readList, readDetail, readActivity } from './resource-reads.js';
import type { Query } from './domain.js';
import type { Resource } from './shared/contracts.js';
import { assignPublicIds } from './user-ids.js';
import type { Activity, Entity, Item, Tag, User } from './shared/contracts.js';
import { profileWithMemberships } from './domain.js';
import { dashboardCards, dashboardTeamRanking, rankingCandidates, readStatistics, type MapUser } from './community-reads.js';
import type { Statistics } from './shared/contracts.js';

export interface DatabaseState {
  users: User[]; entities: Entity[]; tags: Tag[]; items: Item[]; activities: Activity[];
  teamExclusions: { id: string; teamId: string; userId: string; adminId: string; comment: string; createdAt: string }[];
  telegramUsers: Record<string, string>;
  managedAdmins: Record<string,string>;
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
  list?(resource: Resource, query: Query, drafts: boolean, cards: boolean): Promise<unknown>;
  exportProfile?(id: string): Promise<User>;
  detail?(resource: Resource, id: string, drafts: boolean, compact: boolean): Promise<unknown>;
  activity?(query: Pick<Query,'page'|'limit'>, drafts: boolean): Promise<unknown>;
  readAnalytics?<T>(fn: (state: DatabaseState) => T, member?: string): Promise<T>;
  dashboardOverview?(at: Date, drafts:boolean): Promise<unknown>;
  statistics?(includeDrafts: boolean): Promise<Statistics>;
  geographyUsers?(overview?: boolean): Promise<MapUser[]>;
  read<T>(fn: (state: DatabaseState) => T | Promise<T>): Promise<T>;
  write<T>(fn: (state: DatabaseState) => T | Promise<T>): Promise<T>;
  close(): Promise<void>;
  ping?(): Promise<void>;
}
export type CommunityPage = 'tags' | 'items' | 'tag-usage' | 'dashboard' | 'catalog-tags' | 'catalog-items';
type SessionPrincipal = { user: User; telegramId?: string; managedAdmin?: boolean; source?: 'demo' | 'telegram' };
export function emptyState(): DatabaseState {
  return { users: [], entities: [], tags: [], items: [], activities: [], teamExclusions: [], telegramUsers: {}, managedAdmins: {}, userPublicIds: {}, sessions: {}, authRequests: {} };
}

/** A serialized unit of work. Failed callbacks never publish their mutations. */
export class MemoryRepository implements Repository {
  revision = 0;
  protected state: DatabaseState;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(initial: DatabaseState = emptyState(), private file?: string) {
    this.state = { ...structuredClone(initial), teamExclusions: structuredClone(initial.teamExclusions ?? []), managedAdmins: {...initial.managedAdmins}, userPublicIds: structuredClone(initial.userPublicIds ?? {}) };
    assignPublicIds(this.state);
    this.state.entities.forEach(upgradeChallengeGoal);
  }
  async read<T>(fn: (state: DatabaseState) => T | Promise<T>): Promise<T> { await this.queue; return fn(structuredClone(this.state)); }
  async write<T>(fn: (state: DatabaseState) => T | Promise<T>): Promise<T> {
    const operation = this.queue.then(async () => {
      const draft = structuredClone(this.state);
      const result = await fn(draft);
      assignPublicIds(draft);
      draft.entities.forEach(upgradeChallengeGoal);
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
const tables = { users: 'klan_users', entities: 'klan_entities', tags: 'klan_tags', items: 'klan_items', activities: 'klan_activities', teamExclusions: 'klan_team_exclusions' } as const;
const authKeys = ['telegramUsers', 'sessions', 'authRequests', 'userPublicIds','managedAdmins'] as const;

// Keep the original JSON for delta detection without cloning a second graph of profiles and results.
function originalRows(state: DatabaseState) {
  const rows = new Map<string, Map<string, string>>();
  for (const key of Object.keys(tables) as (keyof typeof tables)[])
    rows.set(key, new Map(state[key].map(row => [row.id, JSON.stringify(row)])));
  for (const key of authKeys)
    rows.set(key, new Map(Object.entries(state[key]).map(([id, value]) => [id, JSON.stringify(value)])));
  return rows;
}

/** PostgreSQL adapter. Advisory transaction lock protects cross-entity invariants across API instances. */
export class PostgresRepository implements Repository {
  revision = 0;
  private pool: pg.Pool;
  private writes: Promise<void> = Promise.resolve();
  private pendingWrites = 0;
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
  async geographyUsers(overview = false): Promise<MapUser[]> {
    if (overview) {
      return (await this.pool.query(`SELECT id,id IN (${activeTeamUserIds}) AS "hasActiveTeam",p.* FROM klan_users,jsonb_to_record(data) p(name text,"firstName" text,"lastName" text,callsign text,"publicId" float8,
        location jsonb,initials text,color text,"joinedAt" text) ORDER BY id`)).rows as MapUser[];
    }
    const result = await this.pool.query<MapUser>(`SELECT u.id, u.id IN (${activeTeamUserIds}) AS "hasActiveTeam", p.* FROM klan_users u,
      jsonb_to_record(u.data) AS p(name text, "firstName" text, "lastName" text, username text, callsign text, bio text, location jsonb,
        interests jsonb, facts jsonb, achievements jsonb, tags jsonb, "joinedAt" text, "publicId" double precision,
        initials text, color text) ORDER BY u.id`);
    return result.rows;
  }
  list(resource: Resource, q: Query, drafts: boolean, cards: boolean) {
    return this.snapshot(db => readList(db, resource, q, drafts, cards));
  }
  async exportProfile(id: string) {
    const row = await this.pool.query(`SELECT data - ARRAY['communityImport','historicalImport','importProvenance','access','stats','activeTeams','role','joinedAt','initials','color','publicId']
      AS profile FROM klan_users WHERE id=$1`,[id]);
    if (!row.rowCount) throw notFound();
    return profileWithMemberships(row.rows[0].profile,[],{events:0,books:0,challenges:0});
  }
  detail(resource: Resource, id: string, drafts: boolean, compact: boolean) {
    return this.snapshot(db => readDetail(db, resource, id, drafts, compact));
  }
  activity(q: Pick<Query,'page'|'limit'>, drafts: boolean) {
    return this.snapshot(db => readActivity(db, {page:q.page,limit:q.limit}, drafts));
  }
  statistics(includeDrafts: boolean) {
    return this.snapshot(db => readStatistics(db, includeDrafts));
  }
  private analyticsCache?: {revision:number; expires:number; data:Promise<DatabaseState>};
  async readAnalytics<T>(fn: (state: DatabaseState) => T, member?: string) {
    if (member) return fn(await this.snapshot(db => analyticsState(db,member)));
    const cached = this.analyticsCache;
    if (cached && cached.revision === this.revision && cached.expires > Date.now()) return fn(await cached.data);
    const data = this.snapshot(db => analyticsState(db));
    this.analyticsCache = {revision:this.revision, expires:Date.now()+10_000, data};
    try {
      const state = await data;
      if (this.analyticsCache?.data === data && (state.users.length > 2000 || state.activities.length > 5000 ||
        state.entities.reduce((sum,e) => sum + e.participants.length + (e.results?.length ?? 0),0) > 15000)) this.analyticsCache = undefined;
      return fn(state);
    } catch (error) {
      if (this.analyticsCache?.data === data) this.analyticsCache = undefined;
      throw error;
    }
  }
  dashboardOverview(at: Date, drafts: boolean) {
    return this.snapshot(async db => {
      const row = (await db.query(`SELECT count(*)::int AS users, count(DISTINCT lower(trim(city)||':'||trim(country)))
        FILTER (WHERE trim(city)<>'' AND lat BETWEEN -90 AND 90 AND lng BETWEEN -180 AND 180)::int AS cities
        FROM klan_users,jsonb_to_record(data->'location') p(city text,country text,lat float8,lng float8)`)).rows[0];
      const entities = (await db.query(entityCardSelect + ' ORDER BY e.id')).rows.map(r => r.card) as Entity[];
      const cards = dashboardCards(entities,at), feed = await readActivity(db,{page:1,limit:5},drafts);
      const candidates = rankingCandidates(entities, at);
      let teamRanking = null;
      if (candidates.length) {
        const totals = await db.query<{ challenge: string; team: string; score: number }>(`
          WITH chosen AS (
            SELECT e.id, e.detail FROM unnest($1::text[]) WITH ORDINALITY candidate(id, priority)
            JOIN klan_entities e ON e.id=candidate.id
            WHERE e.detail @? '$.results[*].team.id' ORDER BY priority LIMIT 1
          )
          SELECT chosen.id AS challenge, r.team->>'id' AS team, sum(r.value) AS score
          FROM chosen, jsonb_to_recordset(chosen.detail->'results') r(team jsonb, value float8)
          WHERE r.team->>'id' IS NOT NULL GROUP BY 1,2`, [candidates.map(c => c.id)]);
        const challenge = candidates.find(c => c.id === totals.rows[0]?.challenge);
        if (challenge) teamRanking = dashboardTeamRanking(challenge, entities, new Map(totals.rows.map(r => [r.team, r.score])));
      }
      return {stats:{...row,...cards.counts},events:cards.events,teams:cards.teams,challenges:cards.challenges,teamRanking,activity:feed.data,activityTotal:feed.meta.total};
    });
  }
  async readPage<T>(page: CommunityPage, fn: (state: DatabaseState) => T, at: Date): Promise<T> {
    const state = emptyState();
    if (page === 'tags' || page === 'items') {
      const result = await this.pool.query(`SELECT data FROM ${tables[page]} ORDER BY id`);
      state[page] = result.rows.map(row => row.data);
      return fn(state);
    }
    return this.snapshot(async db => {
      if (page === 'tag-usage') {
        state.tags = (await db.query(`SELECT t.data, COALESCE(n,0)::int AS count FROM klan_tags t LEFT JOIN
          (SELECT tag->>'id' AS id, count(*) AS n FROM klan_users, jsonb_array_elements(data->'tags') tag GROUP BY 1) usage
          ON usage.id=t.id`)).rows.map(r => ({...r.data, count:r.count}));
        return fn(state);
      }
      if (page === 'catalog-tags' || page === 'catalog-items') {
        const kind = page === 'catalog-tags' ? 'tags' : 'items';
        state[kind] = (await db.query(`SELECT data FROM ${tables[kind]}`)).rows.map(r => r.data);
        if (kind === 'items') {
          state.entities = (await db.query(`SELECT ARRAY(SELECT jsonb_build_object('items',r->'items') FROM jsonb_array_elements(detail->'participants') r) AS participants FROM klan_entities`)).rows as Entity[];
        } else {
          state.users = (await db.query("SELECT id,data->'tags' AS tags FROM klan_users")).rows as User[];
          // Only orphaned snapshots count; current profiles are authoritative.
          state.entities = (await db.query(`SELECT e.card->'tags' AS tags, ARRAY(SELECT jsonb_build_object('user',ref)
            FROM jsonb_array_elements(e.detail->'embeddedTags') ref WHERE NOT EXISTS
            (SELECT 1 FROM klan_users known WHERE known.id=ref->>'id')) AS participants FROM klan_entities e`)).rows as Entity[];
        }
        return fn(state);
      }
      state.users = (await db.query("SELECT data - ARRAY['historicalImport','communityImport','importProvenance'] AS profile FROM klan_users ORDER BY id")).rows.map(r => r.profile);
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
    if (withProfile) return (await this.sessionRows([key], at, true)).get(key)?.principal;
    // Share a database round trip, never an authorization decision from a previous request.
    return new Promise((resolve, reject) => {
      const batch = this.sessionBatch;
      batch.push({ key, at, resolve, reject });
      if (batch.length === 1) setImmediate(() => { void this.flushSessions(batch); });
      if (batch.length === 128) this.sessionBatch = [];
    });
  }

  private sessionBatch: {
    key: string; at: number;
    resolve: (value: SessionPrincipal | undefined) => void;
    reject: (error: unknown) => void;
  }[] = [];

  private async flushSessions(batch: typeof this.sessionBatch) {
    if (this.sessionBatch === batch) this.sessionBatch = [];
    try {
      const keys = [...new Set(batch.map(request => request.key))];
      const rows = await this.sessionRows(keys, Math.min(...batch.map(request => request.at)), false);
      for (const request of batch) {
        const row = rows.get(request.key);
        request.resolve(row && row.expiresAt > request.at ? row.principal : undefined);
      }
    } catch (error) {
      for (const request of batch) request.reject(error);
    }
  }

  private async sessionRows(keys: string[], at: number, withProfile: boolean) {
    const result = await this.pool.query(`
      SELECT s.id, s.data->>'expiresAt' AS expires, CASE WHEN $3 THEN u.data - ARRAY['communityImport','historicalImport','importProvenance']
        ELSE jsonb_build_object('id',u.id,'role',u.data->'role','access',u.data->'access') END AS profile, s.data->>'source' AS source,
        (SELECT id FROM klan_auth WHERE kind = 'telegramUsers' AND data = to_jsonb(u.id) LIMIT 1) AS telegram,
        (SELECT jsonb_object_agg(id,data) FROM klan_auth WHERE kind='managedAdmins') AS bindings,
        CASE WHEN $3 THEN (
          SELECT jsonb_agg(jsonb_build_object('kind', e.kind, 'team', CASE WHEN e.kind = 'teams' THEN
            jsonb_strip_nulls(jsonb_build_object('id', e.id, 'publicId', e.card->'publicId', 'title', e.card->'title', 'description', e.card->'description',
              'memberCount', (SELECT count(DISTINCT (p#>>'{user,id}')) FROM jsonb_array_elements(e.detail->'participants') p))) END)
            ORDER BY e.id)
          FROM klan_entities e
          WHERE (e.kind IN ('events','challenges','teams') AND (e.kind <> 'teams' OR e.card->>'status' = 'active')
            AND e.data @> jsonb_build_object('participants', jsonb_build_array(jsonb_build_object('user', jsonb_build_object('id', u.id)))))
            OR (e.kind = 'books' AND e.data @> jsonb_build_object('readers', jsonb_build_array(jsonb_build_object('id', u.id))))
        ) END AS memberships
      FROM klan_auth s JOIN klan_users u ON u.id = s.data->>'userId'
      WHERE s.kind = 'sessions' AND s.id = ANY($1::text[]) AND (s.data->>'expiresAt')::timestamptz > $2::timestamptz`,
      [keys, new Date(at).toISOString(), withProfile]);
    const rows = new Map<string, { expiresAt: number; principal: SessionPrincipal }>();
    for (const row of result.rows) {
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
      rows.set(row.id, { expiresAt: Date.parse(row.expires), principal: {
        user, managedAdmin:isDeploymentAdmin(row.telegram,row.bindings ?? {}), telegramId: row.telegram ?? undefined, source: row.source ?? undefined,
      } });
    }
    return rows;
  }
  async authRequest(id: string): Promise<DatabaseState['authRequests'][string] | undefined> {
    const result = await this.pool.query("SELECT data FROM klan_auth WHERE kind = 'authRequests' AND id = $1", [id]);
    return result.rows[0]?.data;
  }
  async reconcileAdmins() {
    const db = await this.pool.connect();
    try { return await reconcileDeploymentAdmins(db); }
    finally { db.release(); }
  }
  async migrate() {
    const connection = await this.pool.connect();
    try {
      await connection.query('BEGIN');
      await connection.query('SELECT pg_advisory_xact_lock(54652601)');
      await connection.query('CREATE TABLE IF NOT EXISTS klan_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
      const done = await connection.query('SELECT version FROM klan_migrations WHERE version = 1');
      if (!done.rowCount) { await connection.query(migration); await connection.query('INSERT INTO klan_migrations(version) VALUES(1)'); }
      const indexed = await connection.query('SELECT version FROM klan_migrations WHERE version = 2');
      if (!indexed.rowCount) {
        await connection.query('SELECT pg_advisory_xact_lock(54652602)');
        const state = emptyState();
        for (const collection of ['users','entities'] as const) {
          const rows = await connection.query(`SELECT id,data->'publicId' AS "publicId" FROM ${tables[collection]}`);
          const ids = rows.rows.map(r => ({id:r.id, publicId:r.publicId ?? undefined}));
          if (collection === 'users') state.users = ids as User[];
          else state.entities = ids as Entity[];
        }
        const counters = await connection.query("SELECT id,data FROM klan_auth WHERE kind='userPublicIds'");
        state.userPublicIds = Object.fromEntries(counters.rows.map(r => [r.id,r.data]));
        assignPublicIds(state);
        for (const collection of ['users','entities'] as const) {
          const ids = state[collection].map(row => ({id:row.id, num:row.publicId}));
          await connection.query(`UPDATE ${tables[collection]} t SET data=jsonb_set(t.data,'{publicId}',to_jsonb(r.num))
            FROM jsonb_to_recordset($1::jsonb) r(id text,num bigint) WHERE t.id=r.id AND t.data->>'publicId' IS DISTINCT FROM r.num::text`,[JSON.stringify(ids)]);
        }
        for (const id of ['highWater','entityHighWater']) if (state.userPublicIds[id] !== undefined) await connection.query(
          "INSERT INTO klan_auth VALUES ('userPublicIds',$1,to_jsonb($2::bigint)) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data",[id,state.userPublicIds[id]]);
        await connection.query(readProjections);
        await connection.query(`CREATE UNIQUE INDEX klan_entities_public_id ON klan_entities ((card->>'publicId'));
          CREATE UNIQUE INDEX klan_users_public_id ON klan_users ((data->>'publicId'));
          CREATE INDEX klan_telegram_user ON klan_auth (data) WHERE kind='telegramUsers';
          CREATE INDEX klan_user_list ON klan_users ((data->>'joinedAt') DESC, id);
          CREATE INDEX klan_entity_list ON klan_entities (kind, (card->>'createdAt') DESC, id);
          CREATE INDEX klan_activity_feed ON klan_activities ((data->>'createdAt') DESC, id);
          INSERT INTO klan_migrations(version) VALUES (2)`);
      }
      const converted = await connection.query('SELECT version FROM klan_migrations WHERE version=3');
      if (!converted.rowCount) {
        await connection.query('SELECT pg_advisory_xact_lock(54652602)');
        const legacy = await connection.query(`SELECT id,card->>'category' AS category,card->'goal' AS goal,
          (SELECT count(DISTINCT p#>>'{user,id}')::int FROM jsonb_array_elements(detail->'participants') p) AS members
          FROM klan_entities WHERE kind='challenges' AND card ? 'goal' AND card#>>'{goal,scope}' IS DISTINCT FROM 'participant'`);
        for (const row of legacy.rows) {
          const goal = migratedGoal(row.id,row.category,row.goal,row.members);
          await connection.query("UPDATE klan_entities SET data=jsonb_set(data,'{goal}',$2::jsonb) WHERE id=$1",[row.id,goal]);
        }
        await connection.query('INSERT INTO klan_migrations(version) VALUES(3)');
      }
      const exclusions = await connection.query('SELECT version FROM klan_migrations WHERE version=4');
      if (!exclusions.rowCount) {
        await connection.query('CREATE TABLE klan_team_exclusions (id text PRIMARY KEY, data jsonb NOT NULL)');
        await connection.query('INSERT INTO klan_migrations(version) VALUES(4)');
      }
      const challengeCards = await connection.query('SELECT version FROM klan_migrations WHERE version=5');
      if (!challengeCards.rowCount) {
        await connection.query(cardProjection);
        // Refresh stored cards created by the earlier version of klan_card.
        await connection.query("UPDATE klan_entities SET data=data WHERE kind='challenges' AND NOT card ? 'teamCount'");
        await connection.query('INSERT INTO klan_migrations(version) VALUES(5)');
      }
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
  private async save(connection: pg.PoolClient, before: ReturnType<typeof originalRows>, after: DatabaseState) {
    let communityChanged = false;
    for (const [collection, table] of Object.entries(tables) as [keyof typeof tables, string][]) {
      const previous = before.get(collection)!;
      for (const row of after[collection]) {
        const original = previous.get(row.id);
        previous.delete(row.id);
        const encoded = JSON.stringify(row);
        if (original === encoded) continue;
        communityChanged = true;
        if (collection === 'entities') await connection.query(`INSERT INTO ${table}(id,kind,data) VALUES($1,$2,$3) ON CONFLICT(id) DO UPDATE SET kind=EXCLUDED.kind,data=EXCLUDED.data`, [row.id, (row as Entity).type, encoded]);
        else await connection.query(`INSERT INTO ${table}(id,data) VALUES($1,$2) ON CONFLICT(id) DO UPDATE SET data=EXCLUDED.data`, [row.id, encoded]);
      }
      for (const id of previous.keys()) {
        await connection.query(`DELETE FROM ${table} WHERE id=$1`, [id]);
        communityChanged = true;
      }
    }
    for (const kind of authKeys) {
      const previous = before.get(kind)!;
      for (const [id, data] of Object.entries(after[kind])) {
        const original = previous.get(id);
        previous.delete(id);
        const encoded = JSON.stringify(data);
        if (original !== encoded) await connection.query('INSERT INTO klan_auth(kind,id,data) VALUES($1,$2,$3::jsonb) ON CONFLICT(kind,id) DO UPDATE SET data=EXCLUDED.data', [kind, id, encoded]);
      }
      for (const id of previous.keys()) await connection.query('DELETE FROM klan_auth WHERE kind=$1 AND id=$2', [kind, id]);
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
  write<T>(fn: (state: DatabaseState) => T | Promise<T>): Promise<T> {
    // Writers share an advisory lock. Queue them before checkout to keep connections available for readers.
    if (this.pendingWrites >= 32)
      return Promise.reject(new HttpError(503, 'WRITE_BUSY', 'Сервер занят сохранением изменений. Повторите запрос через несколько секунд.'));
    this.pendingWrites++;
    const result = this.writes.then(() => this.writeTransaction(fn)).finally(() => { this.pendingWrites--; });
    this.writes = result.then(() => {}, () => {});
    return result;
  }
  private async writeTransaction<T>(fn: (state: DatabaseState) => T | Promise<T>): Promise<T> {
    const connection = await this.pool.connect();
    try {
      await connection.query('BEGIN');
      await connection.query('SELECT pg_advisory_xact_lock(54652602)');
      const state = await this.load(connection);
      const before = originalRows(state);
      const result = await fn(state);
      assignPublicIds(state);
      state.entities.forEach(upgradeChallengeGoal);
      const communityChanged = await this.save(connection, before, state);
      await connection.query('COMMIT');
      if (communityChanged) this.revision++;
      return result;
    } catch (error) { await connection.query('ROLLBACK'); throw error; }
    finally { connection.release(); }
  }
  async close() { await this.writes; await this.pool.end(); }
}
