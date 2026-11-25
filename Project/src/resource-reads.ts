import type { PoolClient } from 'pg';
import type { Activity, Entity, Resource, TeamChallengeSummary, User } from './shared/contracts.js';
import { filtered, hydrateUser, paginate, type Query } from './domain.js';
import { emptyState } from './repository.js';
import { notFound } from './errors.js';
import { missingMembersSql, type MissingMemberField } from './admin-member-filters.js';

export function entityCard(entity: Entity) {
  const { id, publicId, type, title, description, status, category, tags, createdAt, location, schedule, goal } = entity;
  return { id, publicId, type, title, description, status, category, tags, createdAt, location, schedule, goal,
    ...(type === 'challenges' && { teamCount: new Set(entity.participants.flatMap(row => row.team ? [row.team.id] : [])).size }),
    participantCount: entity.participantCount ?? entity.participants.length, readerCount: entity.readerCount ?? entity.readers?.length ?? 0 };
}

export function userCard(user: User, showAccess = false) {
  const { id, publicId, role, name, firstName, lastName, callsign, initials, color, bio, location, tags } = user;
  return { id, publicId, role, name, firstName, lastName, callsign, hasActiveTeam: user.hasActiveTeam ?? !!user.activeTeams?.length, initials, color, bio, location, tags, ...(showAccess && user.access && { access:user.access }), stats: { events: user.stats.events } };
}

// Uncorrelated membership set, shared by all profiles in a result page.
export const activeTeamUserIds = `SELECT member#>>'{user,id}' FROM klan_entities team,
  jsonb_array_elements(team.detail->'participants') member WHERE team.kind='teams' AND team.card->>'status'='active'`;

export const entityCardSelect = 'SELECT e.id,e.card FROM klan_entities e';

type Page = Pick<Query, 'page' | 'limit'>;
const meta = (q: Page, total: number) => ({ page: q.page, limit: q.limit, total, pages: Math.max(1, Math.ceil(total / q.limit)) });
const publicProfile = "data - ARRAY['historicalImport','communityImport','importProvenance']";
const visible = (drafts: boolean) => drafts ? 'TRUE' : "card->>'status' IS DISTINCT FROM 'draft'";

async function memberships(db: PoolClient, users: User[], drafts: boolean, cards: boolean) {
  if (!users.length) return [];
  // Batch the page and use JSONB containment (GIN) for membership lookup.
  const found = await db.query(`SELECT u.id, e.kind, e.id AS entity, e.card->>'title' AS title,
    (e.card->>'publicId')::float8 AS "publicId", e.card->>'description' AS description,
    CASE WHEN e.kind='teams' THEN (SELECT count(DISTINCT p#>>'{user,id}')::int FROM jsonb_array_elements(e.detail->'participants') p) END AS members
    FROM unnest($1::text[]) u(id) JOIN klan_entities e ON
    ((e.kind IN (${cards ? "'events'" : "'events','challenges','teams'"}) AND (e.kind <> 'teams' OR e.card->>'status'='active')
      AND e.data @> jsonb_build_object('participants',jsonb_build_array(jsonb_build_object('user',jsonb_build_object('id',u.id)))))
      ${cards ? '' : "OR (e.kind='books' AND e.data @> jsonb_build_object('readers',jsonb_build_array(jsonb_build_object('id',u.id))))"})
    WHERE ${visible(drafts)} ORDER BY e.id`, [users.map(u => u.id)]);
  const state = emptyState();
  const profiles = new Map(users.map(user => [user.id, hydrateUser(state, user)]));
  for (const r of found.rows) {
    const u = profiles.get(r.id)!;
    if (r.kind === 'teams') u.activeTeams!.push({ id: r.entity, publicId: r.publicId, title: r.title, description: r.description, memberCount: r.members });
    else u.stats[r.kind as keyof User['stats']]++;
  }
  return [...profiles.values()];
}

export function compactDetail(entity: Entity, users: Map<string, User>, teams: Map<string, Pick<Entity, 'id'|'title'|'publicId'>>) {
  const people = new Map<string, {index:number; profile:ReturnType<typeof displayUser>}>();
  const teamRefs = new Map<string, {index:number; team:Pick<Entity,'id'|'title'|'publicId'>}>();
  if (entity.type === 'challenges') {
    for (const team of teams.values()) teamRefs.set(team.id, {index:teamRefs.size,team});
  }
  function displayUser(u: User) {
    const { id, publicId, name, initials, color, role, username, firstName, lastName, callsign, hasActiveTeam, location } = u;
    return { id, publicId, name, initials, color, role, username, firstName, lastName, callsign, hasActiveTeam, location };
  }
  function person(u: User) {
    let ref = people.get(u.id);
    if (!ref) {
      ref = {index: people.size, profile: displayUser(users.get(u.id) ?? u)};
      people.set(u.id, ref);
    }
    return ref.index;
  }
  function entry<T extends { user: User; team?: { id: string; title: string } }>(row: T) {
    if (!row.team) return {...row,user:person(row.user)};
    let ref = teamRefs.get(row.team.id);
    if (!ref) {
      ref = {index:teamRefs.size, team:teams.get(row.team.id) ?? row.team};
      teamRefs.set(row.team.id,ref);
    }
    return { ...row, user: person(row.user), team: ref.index };
  }
  const { historicalImport: _history, ...data } = entity as Entity & { historicalImport?: unknown };
  const organizer = entity.organizer && 'userId' in entity.organizer ? users.get(entity.organizer.userId) : undefined;
  return { ...data, organizerUser: organizer && person(organizer), participants: entity.participants.map(entry), readers: entity.readers?.map(person),
    author: entity.author && person(entity.author), results: entity.results?.map(entry), pendingResults: entity.pendingResults?.map(entry),
    people: [...people.values()].map(ref => ref.profile), teams: [...teamRefs.values()].map(ref => ref.team) };
}

type DatedTeamChallenge = TeamChallengeSummary & { finished: boolean; date: string };

function groupTeamChallenges(rows: DatedTeamChallenge[]) {
  const activeTeamChallenges: TeamChallengeSummary[] = [], teamChallenges: TeamChallengeSummary[] = [];
  rows.sort((a,b) => Date.parse(b.date) - Date.parse(a.date) || a.id.localeCompare(b.id));
  for (const { finished, date: _date, ...summary } of rows) {
    (finished ? teamChallenges : activeTeamChallenges).push(summary);
  }
  return { activeTeamChallenges, teamChallenges };
}

export function teamChallengeSummaries(entities: Entity[], teamId: string, now = new Date()) {
  const rows: DatedTeamChallenge[] = [];
  for (const challenge of entities) {
    if (challenge.type !== 'challenges' || challenge.status === 'draft') continue;
    const end = challenge.schedule?.end;
    const finished = ['completed', 'archived', 'closed'].includes(challenge.status) || (!!end && Date.parse(end) <= now.getTime());
    const start = challenge.schedule?.start ?? challenge.createdAt;
    if (!finished && (!['active','in_progress'].includes(challenge.status) || Date.parse(start) > now.getTime())) continue;
    const registered = new Set<string>();
    let members = 0;
    for (const { user, team } of challenge.participants) {
      if (registered.has(user.id)) continue;
      registered.add(user.id);
      if (team?.id === teamId) members++;
    }
    const results = challenge.results?.filter(row => row.team?.id === teamId) ?? [];
    if (!members && !results.length) continue;
    rows.push({ finished, date: finished ? end ?? challenge.createdAt : start,
      id: challenge.id, publicId: challenge.publicId, title: challenge.title, members, personalTarget: challenge.goal?.target ?? null,
      score: results.reduce((sum, row) => sum + row.value, 0), target: challenge.goal ? challenge.goal.target * members : null,
      unit: challenge.goal?.unit ?? 'ед.' });
  }
  return groupTeamChallenges(rows);
}

async function readTeamChallenges(db: PoolClient, teamId: string) {
  const result = await db.query<DatedTeamChallenge>(`SELECT e.id, (e.card->>'publicId')::float8 AS "publicId",
    e.card->>'title' AS title, COALESCE(scores.total, 0) AS score, roster.members::int AS members,
    (e.card#>>'{goal,target}')::float8 AS "personalTarget", phase.finished,
    coalesce(CASE WHEN phase.finished THEN e.card#>>'{schedule,end}' ELSE e.card#>>'{schedule,start}' END, e.card->>'createdAt') AS date,
    (e.card#>>'{goal,target}')::float8 * roster.members AS target, COALESCE(e.card#>>'{goal,unit}', 'ед.') AS unit
    FROM klan_entities e
    CROSS JOIN LATERAL (SELECT e.card->>'status' IN ('completed','archived','closed')
      OR coalesce((e.card#>>'{schedule,end}')::timestamptz <= now(), false) AS finished) phase
    CROSS JOIN LATERAL (SELECT count(*) FILTER (WHERE registered.team=$1) AS members FROM (
      SELECT DISTINCT ON (p#>>'{user,id}') p#>>'{team,id}' AS team
      FROM jsonb_array_elements(e.detail->'participants') WITH ORDINALITY entries(p, ord)
      ORDER BY p#>>'{user,id}', ord
    ) registered) roster
    CROSS JOIN LATERAL (SELECT sum((r->>'value')::float8) AS total FROM jsonb_array_elements(nullif(e.detail->'results','null')) r
      WHERE r#>>'{team,id}'=$1) scores
    WHERE e.kind='challenges' AND e.card->>'status'<>'draft'
      AND (phase.finished OR (e.card->>'status' IN ('active','in_progress')
        AND coalesce(e.card#>>'{schedule,start}',e.card->>'createdAt')::timestamptz <= now()))
      AND (roster.members > 0 OR scores.total IS NOT NULL)`, [teamId]);
  return groupTeamChallenges(result.rows);
}

export async function readDetail(db: PoolClient, resource: Resource, id: string, drafts: boolean, compact: boolean) {
  if (resource === 'users') {
    const row = await db.query(`SELECT ${publicProfile} AS profile FROM klan_users WHERE id=$1 OR data->>'publicId'=$1`, [id]);
    if (!row.rowCount) throw notFound();
    return (await memberships(db, [row.rows[0].profile], drafts, false))[0];
  }
  // Current profiles are loaded in one batch. Only return snapshots for people no longer in the directory.
  const projection = compact ? `detail - ARRAY['snapshots','embeddedTags'] AS entity,
    ARRAY(SELECT snapshot FROM jsonb_array_elements(detail->'snapshots') snapshot WHERE NOT EXISTS
      (SELECT 1 FROM klan_users u WHERE u.id=snapshot->>'id')) AS snapshots` : "data - 'historicalImport' AS entity";
  const row = await db.query(`SELECT ${projection} FROM klan_entities WHERE kind=$2 AND
    (id=$1 OR card->>'publicId'=$1) AND ${visible(drafts)}`, [id, resource]);
  if (!row.rowCount) throw notFound();
  const document = row.rows[0].entity;
  if (resource === 'teams' && compact) Object.assign(document, await readTeamChallenges(db, document.id));
  if (compact) document.snapshots = row.rows[0].snapshots;
  return (await hydrateDetails(db,[document],drafts,compact))[0];
}

type StoredDetail = Entity & { snapshots?: User[] };
async function hydrateDetails(db: PoolClient, documents: StoredDetail[], drafts: boolean, compact: boolean) {
  const ids = new Set<string>(), teamIds = new Set<string>();
  for (const entity of documents) {
    for (const group of [entity.participants,entity.results ?? [],entity.pendingResults ?? []]) for (const row of group) {
      ids.add(row.user.id);
      if (row.team) teamIds.add(row.team.id);
    }
    for (const reader of entity.readers ?? []) ids.add(reader.id);
    if (entity.author) ids.add(entity.author.id);
    if (entity.organizer && 'userId' in entity.organizer) ids.add(entity.organizer.userId);
  }
  const allTeams = compact && documents.some(e => e.type === 'challenges');
  const teams = allTeams || teamIds.size ? (await db.query(`SELECT id,card->>'title' AS title,(card->>'publicId')::float8 AS "publicId"
    FROM klan_entities WHERE kind='teams' AND ${visible(drafts)} ${allTeams ? '' : 'AND id=ANY($1)'} ORDER BY id`, allTeams ? [] : [[...teamIds]])).rows : [];
  const fields = compact ? `SELECT u.id, u.id IN (${activeTeamUserIds}) AS "hasActiveTeam", p.* FROM klan_users u, jsonb_to_record(u.data)
    p("publicId" float8,name text,initials text,color text,role text,username text,"firstName" text,"lastName" text,callsign text,location jsonb) WHERE u.id=ANY($1)` :
    `SELECT ${publicProfile} AS profile FROM klan_users WHERE id=ANY($1)`;
  const rows = ids.size ? (await db.query(fields, [[...ids]])).rows : [];
  const users: User[] = rows.map(r => compact ? r : r.profile);
  const labels = new Map(teams.map(t => [t.id,{id:t.id,title:t.title,publicId:t.publicId}]));
  if (compact) return documents.map(({snapshots = [],...entity}) =>
    compactDetail(entity,new Map([...snapshots,...users].map(u => [u.id,u])),labels));
  const state = emptyState();
  const profiles = await memberships(db, users, drafts, false);
  // Legacy consumers receive hydrated profiles, including membership summaries.
  const byId = new Map(profiles.map(u => [u.id, u]));
  const fallback = (u: User) => byId.get(u.id) ?? hydrateUser(state, u);
  const withUser = <T extends { user: User; team?: { id: string; title: string } }>(p: T) =>
    ({ ...p, user: fallback(p.user), team: p.team && (labels.get(p.team.id) ?? p.team) });
  return documents.map(entity => ({ ...entity,
    organizerUser: entity.organizer && 'userId' in entity.organizer ? byId.get(entity.organizer.userId) : undefined,
    participants: entity.participants.map(withUser), readers: entity.readers?.map(fallback),
    author: entity.author && fallback(entity.author), results: entity.results?.map(withUser), pendingResults: entity.pendingResults?.map(withUser) }));
}

export async function readList(db: PoolClient, resource: Resource, q: Query, drafts: boolean, cards: boolean, missing: MissingMemberField[] = []) {
  const users = resource === 'users';
  const table = users ? 'klan_users' : 'klan_entities';
  const args = users ? [] : [resource];
  const where = users ? missingMembersSql(missing) : `kind=$1 AND ${drafts ? 'TRUE' : "card->>'status' IS DISTINCT FROM 'draft'"}`;
  let ids: string[], total: number;
  const byDateOnly = !q.q.trim() && !q.city && !q.tag && !q.status && !q.category && q.sort.endsWith('createdAt');
  if (byDateOnly && users && missing.length) {
    const result = await db.query(`WITH matches AS MATERIALIZED (SELECT id, data->>'joinedAt' AS joined FROM klan_users WHERE ${where})
      SELECT (SELECT count(*)::int FROM matches) AS total, ARRAY(SELECT id FROM matches ORDER BY joined ${q.sort.startsWith('-') ? 'DESC' : 'ASC'}, id
        LIMIT $1 OFFSET $2) AS ids`, [q.limit, (q.page - 1) * q.limit]);
    ({ ids, total } = result.rows[0]);
  } else if (byDateOnly) {
    total = (await db.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`, args)).rows[0].n;
    const field = users ? 'joinedAt' : 'createdAt';
    ids = (await db.query(`SELECT id FROM ${table} WHERE ${where} ORDER BY (${users ? 'data' : 'card'}->>'${field}') ${q.sort.startsWith('-') ? 'DESC' : 'ASC'}, id
      LIMIT $${args.length+1} OFFSET $${args.length+2}`, [...args, q.limit, (q.page-1)*q.limit])).rows.map(r => r.id);
  } else {
    // Use the same Russian natural collation and multi-word search as the memory adapter.
    const userFields = q.q.trim() ? 'name text,username text,callsign text,bio text,location jsonb,interests jsonb,facts jsonb,achievements jsonb,tags jsonb,"joinedAt" text'
      : 'name text,location jsonb,tags jsonb,"joinedAt" text';
    const fields = users ? userFields
      : 'title text,description text,status text,category text,location jsonb,tags jsonb,"createdAt" text';
    const rows = await db.query(`SELECT id,p.* FROM ${table}, jsonb_to_record(${users ? 'data' : 'card'}) p(${fields}) WHERE ${where} ORDER BY id`, args);
    const page = paginate(filtered(rows.rows as Entity[], q), q);
    ids = page.data.map(e => e.id); total = page.meta.total;
  }
  const pageMeta = meta({page:q.page,limit:q.limit},total);
  if (!ids.length) return { data: [], meta: pageMeta };
  if (users) {
    const fields = cards ? `SELECT id,id IN (${activeTeamUserIds}) AS "hasActiveTeam",p.* FROM klan_users, jsonb_to_record(data) p("publicId" float8,role text,name text,"firstName" text,"lastName" text,callsign text,initials text,color text,bio text,location jsonb,tags jsonb${drafts ? ',access jsonb' : ''}) WHERE id=ANY($1)` :
      `SELECT ${publicProfile} AS profile FROM klan_users WHERE id=ANY($1)`;
    const rows = (await db.query(fields,[ids])).rows;
    const profiles = await memberships(db, rows.map(r => cards ? r : r.profile), drafts, cards);
    const byId = new Map(profiles.map(u => [u.id, cards ? userCard(u,drafts) : u]));
    return { data: ids.map(id => byId.get(id)), meta: pageMeta };
  }
  if (cards) {
    const rows = (await db.query(entityCardSelect + ' WHERE e.id=ANY($1)', [ids])).rows;
    const byId = new Map(rows.map(r => [r.id,r.card]));
    return { data: ids.map(id => byId.get(id)), meta: pageMeta };
  }
  const rows = await db.query("SELECT id,data-'historicalImport' AS entity FROM klan_entities WHERE id=ANY($1)",[ids]);
  const byId = new Map(rows.rows.map(r => [r.id,r.entity]));
  return { data: await hydrateDetails(db,ids.map(id => byId.get(id)),drafts,false), meta:pageMeta };
}

export const activityTargetUserJoin = " LEFT JOIN klan_users target_user ON split_part(a.data#>>'{target,path}','/',2)='users' AND (target_user.id=split_part(a.data#>>'{target,path}','/',3) OR target_user.data->>'publicId'=split_part(a.data#>>'{target,path}','/',3))";
export function activityIdentitySql(alias: 'actor' | 'target_user') {
  return `(SELECT jsonb_strip_nulls(to_jsonb(identity) || jsonb_build_object('id',${alias}.id,
    'hasActiveTeam',${alias}.id IN (${activeTeamUserIds})))
    FROM jsonb_to_record(${alias}.data) identity("publicId" float8,name text,"firstName" text,"lastName" text,callsign text,initials text,color text)
    WHERE ${alias}.id IS NOT NULL)`;
}

export async function readActivity(db: PoolClient, q: Page, drafts: boolean) {
  const join = `FROM klan_activities a LEFT JOIN klan_entities e ON (e.id=split_part(a.data#>>'{target,path}','/',3) OR e.card->>'publicId'=split_part(a.data#>>'{target,path}','/',3))
    AND e.kind=split_part(a.data#>>'{target,path}','/',2)`;
  const actorJoin = " LEFT JOIN klan_users actor ON actor.id=a.data#>>'{actor,id}'";
  const where = drafts ? '' : " WHERE e.card->>'status' IS DISTINCT FROM 'draft'";
  const total = (await db.query('SELECT count(*)::int AS n ' + (drafts ? 'FROM klan_activities' : join + where))).rows[0].n;
  const rows = await db.query(`SELECT a.data, coalesce(e.kind,'users') AS kind, coalesce(e.card->>'publicId',target_user.data->>'publicId') AS number,
    ${activityIdentitySql('actor')} AS identity, ${activityIdentitySql('target_user')} AS target_identity
    ${join}${activityTargetUserJoin}${actorJoin}${where}
    ORDER BY (a.data->>'createdAt') DESC, a.id LIMIT $1 OFFSET $2`, [q.limit,(q.page-1)*q.limit]);
  const data = rows.rows.map(row => {
    const activity: Activity = row.data;
    Object.assign(activity.actor, row.identity);
    if (activity.target && row.target_identity) activity.target.user = row.target_identity;
    if (row.number && activity.target) activity.target.path = `/${row.kind}/${row.number}`;
    return activity;
  });
  return {data,meta:meta(q,total)};
}
