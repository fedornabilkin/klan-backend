import type { PoolClient } from 'pg';
import type { Entity, Statistics, User } from './shared/contracts.js';
import type { SearchUser } from './domain.js';
import { profileEntryText } from './shared/profile-entries.js';

export type MapUser = SearchUser & Pick<User, 'publicId' | 'initials' | 'color'>;
type StatisticsUser = Pick<User, 'tags' | 'achievements'> & { city: string };

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
  const teams = await db.query<Statistics['teams'][number]>(`SELECT id, data->>'title' AS title,
    jsonb_array_length(data->'participants') AS count FROM klan_entities
    WHERE kind = 'teams' AND ($1 OR data->>'status' IS DISTINCT FROM 'draft') ORDER BY id`, [includeDrafts]);
  const activity = await db.query<{day: string}>(`SELECT left(data->>'createdAt', 10) AS day FROM klan_activities a
    WHERE $1 OR NOT EXISTS (SELECT 1 FROM klan_entities e WHERE e.data->>'status' = 'draft'
      AND a.data#>>'{target,path}' = '/' || e.kind || '/' || e.id)`, [includeDrafts]);
  return statistics(users.rows, teams.rows, activity.rows.map(row => row.day));
}
