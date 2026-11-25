import type { PoolClient } from 'pg';
import type { ChallengePodium, Entity, Statistics, User, UserIdentity } from './shared/contracts.js';
import type { SearchUser } from './domain.js';
import { activeTeamUserIds } from './resource-reads.js';
import { profileEntryText } from './shared/profile-entries.js';
import { publicIdentity } from './activity-view.js';
export { publicIdentity } from './activity-view.js';

export type MapUser = SearchUser & Pick<User, 'publicId' | 'initials' | 'color' | 'firstName' | 'lastName' | 'hasActiveTeam'>;
type StatisticsUser = Pick<User, 'tags' | 'achievements'> & { city: string };

export function rankingCandidates(entities: Entity[], now: Date) {
  const time = now.getTime();
  const ongoing = (e: Entity) => e.status === 'active' && Date.parse(e.schedule!.end) >= time;
  const orderDate = (e: Entity) => Date.parse(ongoing(e) ? e.schedule!.start : e.schedule!.end);
  return entities.filter(e => e.type === 'challenges' && e.status !== 'draft' && e.schedule
    && Date.parse(e.schedule.start) <= time
    && (ongoing(e) || Date.parse(e.schedule.end) <= time || ['completed','archived','closed'].includes(e.status)))
    .sort((a, b) => Number(ongoing(b)) - Number(ongoing(a))
      || orderDate(b) - orderDate(a) || a.id.localeCompare(b.id));
}

const teamNames = new Intl.Collator('ru', { numeric: true });
export function dashboardTeamRanking(challenge: Entity, entities: Entity[], scores: Map<string, number>) {
  const leaders = entities.filter(e => e.type === 'teams' && e.status !== 'draft')
    .map(({ id, publicId, title }) => ({ id, publicId, title, score: scores.get(id) ?? 0 }))
    .sort((a, b) => b.score - a.score || teamNames.compare(a.title, b.title) || a.id.localeCompare(b.id))
    .slice(0, 4);
  const { id, publicId, title } = challenge;
  return { challenge: { id, publicId, title }, unit: challenge.goal?.unit || 'ед.', leaders };
}

export function dashboardCards(entities: Entity[], now: Date) {
  const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  const inMonth = (entity: Entity) => entity.schedule && Date.parse(entity.schedule.start) < end && Date.parse(entity.schedule.end) >= start;
  const events = entities.filter(e => e.type === 'events' && inMonth(e) && !['draft', 'archived'].includes(e.status))
    .sort((a, b) => a.schedule!.start.localeCompare(b.schedule!.start));
  const challenges = entities.filter(e => e.type === 'challenges' && inMonth(e) && e.status === 'active');
  const teams = entities.filter(e => e.type === 'teams' && e.status === 'active');
  return {
    counts: { events: events.length, challenges: challenges.length, teams: teams.length },
    events: events.filter(e => Date.parse(e.schedule!.end) >= now.getTime()).slice(0, 4),
    challenges: challenges.slice(0, 3), teams: teams.slice(0, 4),
  };
}

type ChallengeInfo = Pick<Entity, 'id' | 'publicId' | 'title' | 'goal' | 'status' | 'schedule' | 'createdAt'>;
type TeamInfo = Pick<Entity, 'id' | 'publicId' | 'title'>;
type Total = { challenge: string; kind: 'team' | 'person'; id: string; score: number };

export function challengeTotals(entities: Entity[]): Total[] {
  const totals: Total[] = [];
  for (const challenge of entities) {
    if (challenge.type !== 'challenges' || challenge.status === 'draft') continue;
    const people = new Map<string, number>(), teams = new Map<string, number>();
    for (const result of challenge.results ?? []) {
      people.set(result.user.id, (people.get(result.user.id) ?? 0) + result.value);
      if (result.team) teams.set(result.team.id, (teams.get(result.team.id) ?? 0) + result.value);
    }
    for (const [id, score] of people) totals.push({ challenge: challenge.id, kind: 'person', id, score });
    for (const [id, score] of teams) totals.push({ challenge: challenge.id, kind: 'team', id, score });
  }
  return totals;
}

export function challengePodiums(challenges: ChallengeInfo[], users: UserIdentity[], teams: TeamInfo[], totals: Total[], now = new Date()): ChallengePodium[] {
  const byUser = new Map(users.map(user => [user.id,user]));
  const byTeam = new Map(teams.map(team => [team.id,team]));
  const podiums = new Map<string, ChallengePodium>();
  const date = (challenge: ChallengeInfo) => challenge.schedule?.start ?? challenge.createdAt;
  for (const c of challenges.slice().sort((a,b) => date(b).localeCompare(date(a)) || a.id.localeCompare(b.id))) {
    const finished = ['completed','closed','archived'].includes(c.status) || (!!c.schedule && Date.parse(c.schedule.end) <= now.getTime());
    if (c.status === 'draft' || (!finished && (!['active','in_progress'].includes(c.status) || Date.parse(date(c)) > now.getTime()))) continue;
    podiums.set(c.id, { id:c.id, publicId:c.publicId, title:c.title, unit:c.goal?.unit || 'ед.', finished, teams:[], people:[] });
  }
  for (const { challenge, kind, id, score } of totals) {
    const podium = podiums.get(challenge);
    if (!podium || score <= 0) continue;
    if (kind === 'team') {
      const team = byTeam.get(id);
      if (team) podium.teams.push({ team: { id, publicId:team.publicId, title:team.title }, score });
    } else {
      const user = byUser.get(id);
      if (user) podium.people.push({ user:publicIdentity(user, !!user.hasActiveTeam), score });
    }
  }
  for (const podium of podiums.values()) {
    podium.teams = podium.teams.sort((a,b) => b.score-a.score || teamNames.compare(a.team.title,b.team.title) || a.team.id.localeCompare(b.team.id)).slice(0,3);
    podium.people = podium.people.sort((a,b) => b.score-a.score || teamNames.compare(a.user.name,b.user.name) || a.user.id.localeCompare(b.user.id)).slice(0,3);
  }
  return [...podiums.values()];
}

export function statistics(users: StatisticsUser[], teams: Statistics['teams'], days: string[], challenges: ChallengePodium[]): Statistics {
  function counts(values: string[]) {
    const groups = new Map<string, number>();
    for (const name of values) groups.set(name, (groups.get(name) ?? 0) + 1);
    return [...groups].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
  }
  return {
    users: users.length, cities: counts(users.map(u => u.city.trim()).filter(Boolean)),
    interests: counts(users.flatMap(u => u.tags.map(t => t.name))),
    achievements: counts(users.flatMap(u => u.achievements.map(profileEntryText))), teams,
    challenges,
    activity: counts(days).map(({ name, count }) => ({ date: name, count })).sort((a, b) => a.date.localeCompare(b.date)),
  };
}

export async function readStatistics(db: PoolClient, includeDrafts: boolean): Promise<Statistics> {
  const users = await db.query<StatisticsUser & UserIdentity>(`SELECT u.id,p.*, u.id IN (${activeTeamUserIds}) AS "hasActiveTeam",
    u.data#>>'{location,city}' AS city FROM klan_users u, jsonb_to_record(u.data)
    p(tags jsonb,achievements jsonb,name text,"publicId" float8,"firstName" text,"lastName" text,callsign text,initials text,color text) ORDER BY u.id`);
  const teams = await db.query<Statistics['teams'][number] & {status:string}>(`SELECT id, card->>'status' AS status, (card->>'publicId')::double precision AS "publicId", card->>'title' AS title,
    (card->>'participantCount')::int AS count FROM klan_entities
    WHERE kind = 'teams' AND ($1 OR card->>'status' IS DISTINCT FROM 'draft') ORDER BY id`, [includeDrafts]);
  const activity = await db.query<{day: string}>(`SELECT left(data->>'createdAt', 10) AS day FROM klan_activities a
    WHERE $1 OR NOT EXISTS (SELECT 1 FROM klan_entities e WHERE e.card->>'status' = 'draft'
      AND a.data#>>'{target,path}' IN ('/' || e.kind || '/' || e.id, '/' || e.kind || '/' || (e.card->>'publicId')))`, [includeDrafts]);
  const challenges = await db.query<{card: ChallengeInfo}>("SELECT card FROM klan_entities WHERE kind='challenges' AND card->>'status'<>'draft'");
  const totals = await db.query<Total>(`SELECT e.id AS challenge, CASE WHEN grouping(r.person)=0 THEN 'person' ELSE 'team' END AS kind,
    coalesce(r.person,r.team) AS id, sum(r.score) AS score
    FROM klan_entities e CROSS JOIN LATERAL (
      SELECT x#>>'{user,id}' AS person, x#>>'{team,id}' AS team, (x->>'value')::float8 AS score
      FROM jsonb_array_elements(nullif(e.detail->'results','null')) x
    ) r WHERE e.kind='challenges' AND e.card->>'status'<>'draft'
    GROUP BY GROUPING SETS ((e.id,r.person),(e.id,r.team)) HAVING coalesce(r.person,r.team) IS NOT NULL AND sum(r.score)>0`);
  const podiums = challengePodiums(challenges.rows.map(row => row.card), users.rows, teams.rows.filter(t => t.status !== 'draft'), totals.rows);
  return statistics(users.rows, teams.rows.map(({status, ...team}) => team), activity.rows.map(row => row.day), podiums);
}
