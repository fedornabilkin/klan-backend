import type { PoolClient } from 'pg';
import type { Entity, Statistics, User } from './shared/contracts.js';
import type { SearchUser } from './domain.js';
import { profileEntryText } from './shared/profile-entries.js';

export type MapUser = SearchUser & Pick<User, 'publicId' | 'initials' | 'color'>;
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

export function statistics(users: StatisticsUser[], teams: Statistics['teams'], days: string[]): Statistics {
  function counts(values: string[]) {
    const groups = new Map<string, number>();
    for (const name of values) groups.set(name, (groups.get(name) ?? 0) + 1);
    return [...groups].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
  }
  return {
    users: users.length, cities: counts(users.map(u => u.city.trim()).filter(Boolean)),
    interests: counts(users.flatMap(u => u.tags.map(t => t.name))),
    achievements: counts(users.flatMap(u => u.achievements.map(profileEntryText))), teams,
    activity: counts(days).map(({ name, count }) => ({ date: name, count })).sort((a, b) => a.date.localeCompare(b.date)),
  };
}

export async function readStatistics(db: PoolClient, includeDrafts: boolean): Promise<Statistics> {
  const users = await db.query<StatisticsUser>(`SELECT data#>>'{location,city}' AS city, data->'tags' AS tags,
    data->'achievements' AS achievements FROM klan_users ORDER BY id`);
  const teams = await db.query<Statistics['teams'][number]>(`SELECT id, (data->>'publicId')::double precision AS "publicId", data->>'title' AS title,
    jsonb_array_length(data->'participants') AS count FROM klan_entities
    WHERE kind = 'teams' AND ($1 OR data->>'status' IS DISTINCT FROM 'draft') ORDER BY id`, [includeDrafts]);
  const activity = await db.query<{day: string}>(`SELECT left(data->>'createdAt', 10) AS day FROM klan_activities a
    WHERE $1 OR NOT EXISTS (SELECT 1 FROM klan_entities e WHERE e.data->>'status' = 'draft'
      AND a.data#>>'{target,path}' IN ('/' || e.kind || '/' || e.id, '/' || e.kind || '/' || (e.card->>'publicId')))`, [includeDrafts]);
  return statistics(users.rows, teams.rows, activity.rows.map(row => row.day));
}
