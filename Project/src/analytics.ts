import { Router } from 'express';
import { z } from 'zod';
import type { Activity, Entity, User } from './shared/contracts.js';
import type { AnalyticsChallenge, AnalyticsCount, AnalyticsMember, AnalyticsMembers, AnalyticsParticipation, AnalyticsRange, CommunityAnalytics, MemberAnalytics } from './shared/analytics.js';
import type { DatabaseState, Repository } from './repository.js';
import { getUser, paginate, publicActivity } from './domain.js';
import { HttpError } from './errors.js';
import { requireCapability } from './access.js';

const dayMs = 86_400_000;
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}, 'Некорректная календарная дата');
const rangeSchema = z.object({ from: dateSchema.optional(), to: dateSchema.optional() });
const membersSchema = z.object({
  q: z.string().trim().max(200).default(''),
  activity: z.enum(['all', 'active', 'inactive']).default('all'),
  sort: z.enum(['-actions', '-lastActivity', '-completeness', 'name', '-joinedAt']).default('-actions'),
  page: z.coerce.number().int().min(1).max(100000).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(12),
});
const activitySchema = z.object({
  activityPage: z.coerce.number().int().min(1).max(100000).default(1),
  activityLimit: z.coerce.number().int().min(1).max(50).default(12),
});
export type AnalyticsMemberQuery = z.infer<typeof membersSchema>;

/** Inclusive UTC calendar dates; bounded to prevent accidental unbounded chart creation. */
export function parseAnalyticsRange(input: unknown, now = new Date()): AnalyticsRange {
  const parsed = rangeSchema.parse(input);
  const today = now.toISOString().slice(0, 10);
  const to = parsed.to ?? today;
  const from = parsed.from ?? new Date(Date.parse(`${to}T00:00:00Z`) - 29 * dayMs).toISOString().slice(0, 10);
  const days = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / dayMs) + 1;
  if (days < 1) throw new HttpError(400, 'INVALID_ANALYTICS_RANGE', 'Начало периода должно быть не позже окончания.');
  if (days > 366) throw new HttpError(400, 'ANALYTICS_RANGE_TOO_LONG', 'Выберите период не более 366 дней.');
  if (to > today) throw new HttpError(400, 'ANALYTICS_FUTURE_RANGE', 'Окончание периода не может быть в будущем.');
  return { from, to, days, timezone: 'UTC' };
}

function inRange(value: string, range: AnalyticsRange): boolean {
  const timestamp = Date.parse(value.length === 10 ? `${value}T00:00:00Z` : value);
  return Number.isFinite(timestamp) && timestamp >= Date.parse(`${range.from}T00:00:00Z`)
    && timestamp < Date.parse(`${range.to}T00:00:00Z`) + dayMs;
}

function utcDay(value: string): string { return new Date(value).toISOString().slice(0, 10); }
function byRecent(a: Activity, b: Activity): number { return Date.parse(b.createdAt) - Date.parse(a.createdAt) || a.id.localeCompare(b.id); }
function validActivities(state: DatabaseState): Activity[] { return state.activities.filter(activity => Number.isFinite(Date.parse(activity.createdAt))); }
function grouped(values: string[]): AnalyticsCount[] {
  const counts = new Map<string, number>();
  for (const value of values) if (value.trim()) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'ru'));
}

export function analyticsProfileFields(user: User): MemberAnalytics['profileFields'] {
  return [
    { label: 'Имя', filled: Boolean(user.name.trim()) },
    { label: 'О себе', filled: Boolean(user.bio.trim()) },
    { label: 'Город', filled: Boolean(user.location.city.trim()) },
    { label: 'Страна', filled: Boolean(user.location.country.trim()) },
    { label: 'Теги', filled: user.tags.length > 0 },
    { label: 'Факты', filled: user.facts.length > 0 },
    { label: 'Увлечения', filled: user.interests.length > 0 },
    { label: 'Достижения', filled: user.achievements.length > 0 },
  ];
}

function completeness(user: User): number {
  const fields = analyticsProfileFields(user);
  return Math.round(fields.filter(field => field.filled).length / fields.length * 100);
}

function memberIndex(state: DatabaseState, range: AnalyticsRange, activities: Activity[]) {
  const own = new Map<string,Activity[]>(), results = new Map<string,number>();
  const activeMembers = new Set<string>();
  const current = new Map<string,{events:number;challenges:number;teams:number;books:number}>();
  for (const activity of activities) {
    const rows = own.get(activity.actor.id);
    if (rows) rows.push(activity); else own.set(activity.actor.id,[activity]);
  }
  for (const entity of state.entities) {
    const kind = entity.type;
    if (kind !== 'events' && kind !== 'challenges' && kind !== 'teams' && kind !== 'books') continue;
    const ids = kind === 'books' ? entity.readers?.map(u => u.id) : entity.participants.map(p => p.user.id);
    for (const id of new Set(ids)) {
      const counts = current.get(id) ?? {events:0,challenges:0,teams:0,books:0};
      if (kind === 'teams' && entity.status === 'active') activeMembers.add(id);
      counts[kind]++;
      current.set(id,counts);
    }
    if (kind === 'challenges') for (const r of entity.results ?? []) {
      if (inRange(r.date,range)) results.set(r.user.id,(results.get(r.user.id) ?? 0)+1);
    }
  }
  return {own,results,current,activeMembers};
}
function memberRow(index: ReturnType<typeof memberIndex>, user: User, range: AnalyticsRange): AnalyticsMember {
  const ownActivities = index.own.get(user.id) ?? [];
  const period = ownActivities.filter(activity => inRange(activity.createdAt, range));
  const { id, publicId, name, firstName, lastName, callsign, initials, color, role, joinedAt, location } = user;
  return {
    user: { hasActiveTeam:index.activeMembers.has(id), id, publicId, name, firstName, lastName, callsign, initials, color, role, joinedAt, location },
    period: {
      actions: period.length,
      activeDays: new Set(period.map(activity => utcDay(activity.createdAt))).size,
      resultEntries: index.results.get(id) ?? 0,
    },
    lastRecordedActivity: ownActivities.slice().sort(byRecent)[0]?.createdAt ?? null,
    profileCompleteness: completeness(user),
    current: {
      ...(index.current.get(id) ?? {events:0,challenges:0,teams:0,books:0}),
      achievements: user.achievements.length,
    },
  };
}

function participation(entity: Entity): AnalyticsParticipation {
  return { id: entity.id, ...(entity.publicId && { publicId: entity.publicId }), title: entity.title, status: entity.status, participants: new Set(entity.participants.map(participant => participant.user.id)).size, start: entity.schedule?.start, end: entity.schedule?.end };
}

/** Challenge sums always stay attached to a single challenge and unit. */
function challenge(entity: Entity, range: AnalyticsRange, userId?: string): AnalyticsChallenge {
  const results = (entity.results ?? []).filter(result => userId === undefined || result.user.id === userId);
  const period = results.filter(result => inRange(result.date, range));
  return {
    id: entity.id, ...(entity.publicId && { publicId: entity.publicId }), title: entity.title, unit: entity.goal?.unit ?? 'ед.',
    participants: new Set(entity.participants.map(participant => participant.user.id)).size,
    periodEntries: period.length, periodContributors: new Set(period.map(result => result.user.id)).size,
    periodValue: period.reduce((sum, result) => sum + result.value, 0),
    totalValue: results.reduce((sum, result) => sum + result.value, 0),
  };
}

export function communityAnalytics(state: DatabaseState, range: AnalyticsRange): CommunityAnalytics {
  const activities = validActivities(state);
  const period = activities.filter(activity => inRange(activity.createdAt, range));
  const currentMemberIds = new Set(state.users.map(user => user.id));
  const activeMembers = new Set(period.map(activity => activity.actor.id).filter(id => currentMemberIds.has(id))).size;
  const newMembers = state.users.filter(user => inRange(user.joinedAt, range));
  const results = state.entities.filter(entity => entity.type === 'challenges').flatMap(entity => entity.results ?? []).filter(result => inRange(result.date, range));
  const dates = Array.from({ length: range.days }, (_, index) => new Date(Date.parse(`${range.from}T00:00:00Z`) + index * dayMs).toISOString().slice(0, 10));
  const daily = new Map(dates.map(date => [date,{actions:0,actors:new Set<string>(),newMembers:0}]));
  for (const activity of period) {
    const row = daily.get(utcDay(activity.createdAt))!;
    row.actions++;
    if (currentMemberIds.has(activity.actor.id)) row.actors.add(activity.actor.id);
  }
  for (const user of newMembers) daily.get(utcDay(user.joinedAt))!.newMembers++;
  const chronological = activities.slice().sort(byRecent);
  const entities = (type: Entity['type']) => state.entities.filter(entity => entity.type === type);
  const places = state.users.filter(user => user.location.city.trim());
  return {
    range,
    coverage: { firstRecordedActivity: chronological.at(-1)?.createdAt ?? null, lastRecordedActivity: chronological[0]?.createdAt ?? null, storedActions: activities.length },
    period: {
      actions: period.length, activeMembers, inactiveMembers: state.users.length - activeMembers,
      activeMemberPercent: state.users.length ? Math.round(activeMembers / state.users.length * 100) : 0,
      newMembers: newMembers.length, resultEntries: results.length, resultContributors: new Set(results.map(result => result.user.id)).size,
    },
    current: {
      members: state.users.length,
      cities: new Set(places.map(user => `${user.location.country.toLocaleLowerCase('ru')}:${user.location.city.toLocaleLowerCase('ru')}`)).size,
      countries: new Set(state.users.map(user => user.location.country.trim().toLocaleLowerCase('ru')).filter(Boolean)).size,
      activeTeams: entities('teams').filter(entity => entity.status === 'active').length,
      eventRegistrations: entities('events').reduce((sum, entity) => sum + new Set(entity.participants.map(participant => participant.user.id)).size, 0),
      challengeRegistrations: entities('challenges').reduce((sum, entity) => sum + new Set(entity.participants.map(participant => participant.user.id)).size, 0),
      bookReadMarks: entities('books').reduce((sum, entity) => sum + new Set(entity.readers?.map(reader => reader.id) ?? []).size, 0),
      averageProfileCompleteness: state.users.length ? Math.round(state.users.reduce((sum, user) => sum + completeness(user), 0) / state.users.length) : 0,
    },
    daily: [...daily].map(([date,row]) => ({date,actions:row.actions,activeMembers:row.actors.size,newMembers:row.newMembers})),
    actions: grouped(period.map(activity => activity.action)),
    geography: grouped(places.map(user => [user.location.city, user.location.country].filter(Boolean).join(', '))),
    interests: grouped(state.users.flatMap(user => [...new Map(user.tags.map(tag => [tag.id, tag.name])).values()])),
    teams: entities('teams').map(participation).sort((a, b) => b.participants - a.participants || a.title.localeCompare(b.title, 'ru')),
    events: entities('events').map(participation).sort((a, b) => b.participants - a.participants || a.title.localeCompare(b.title, 'ru')),
    challenges: entities('challenges').map(entity => challenge(entity, range)),
  };
}

export function membersAnalytics(state: DatabaseState, range: AnalyticsRange, input: unknown): AnalyticsMembers {
  const query = membersSchema.parse(input);
  const activities = validActivities(state);
  const index = memberIndex(state,range,activities);
  const terms = query.q.toLocaleLowerCase('ru').split(/\s+/).filter(Boolean);
  const rows = state.users
    .filter(user => terms.every(term => [user.name, user.username, user.location.city, user.location.country].join(' ').toLocaleLowerCase('ru').includes(term)))
    .map(user => memberRow(index, user, range))
    .filter(row => query.activity === 'all' || (query.activity === 'active' ? row.period.actions > 0 : row.period.actions === 0));
  rows.sort((a, b) => {
    const compared = query.sort === 'name' ? a.user.name.localeCompare(b.user.name, 'ru')
      : query.sort === '-actions' ? b.period.actions - a.period.actions
      : query.sort === '-completeness' ? b.profileCompleteness - a.profileCompleteness
      : query.sort === '-joinedAt' ? Date.parse(b.user.joinedAt) - Date.parse(a.user.joinedAt)
      : (b.lastRecordedActivity ? Date.parse(b.lastRecordedActivity) : 0) - (a.lastRecordedActivity ? Date.parse(a.lastRecordedActivity) : 0);
    return compared || a.user.id.localeCompare(b.user.id);
  });
  return { ...paginate(rows, query), range };
}

export function memberAnalytics(state: DatabaseState, userId: string, range: AnalyticsRange, input: unknown): MemberAnalytics {
  const query = activitySchema.parse(input);
  const user = getUser(state, userId);
  const activities = validActivities(state);
  const period = activities.filter(activity => activity.actor.id === user.id && inRange(activity.createdAt, range)).sort(byRecent);
  const page = paginate(period, { page: query.activityPage, limit: query.activityLimit });
  const participationEntities = state.entities.filter(entity => entity.participants.some(participant => participant.user.id === user.id)
    || (entity.type === 'books' && entity.readers?.some(reader => reader.id === user.id)));
  return {
    range, member: memberRow(memberIndex(state, range, activities), user, range), profileFields: analyticsProfileFields(user),
    participation: participationEntities.map(entity => ({ id: entity.id, ...(entity.publicId && { publicId: entity.publicId }), type: entity.type, title: entity.title, status: entity.status, start: entity.schedule?.start, end: entity.schedule?.end })),
    challenges: state.entities.filter(entity => entity.type === 'challenges' && (entity.participants.some(participant => participant.user.id === user.id) || entity.results?.some(result => result.user.id === user.id))).map(entity => challenge(entity, range, user.id)),
    actions: grouped(period.map(activity => activity.action)),
    activity: { ...page, data:page.data.map(a => publicActivity(state,a)) },
  };
}

/** Mount after auth.requireAuth at /api/admin/analytics, before generic resource routes. */
export function createAnalyticsRouter(repo: Repository): Router {
  const router = Router();
  const read = <T>(fn: (state: DatabaseState) => T, member?: string) => repo.readAnalytics ? repo.readAnalytics(fn,member) : repo.read(fn);
  router.use((req, _res, next) => {
    if (!req.user) throw new HttpError(401, 'UNAUTHORIZED', 'Требуется авторизация.');
    requireCapability(req.user, 'analytics.read'); next();
  });
  router.get('/community', async (req, res) => {
    const range = parseAnalyticsRange(req.query);
    res.json({ data: await read(state => communityAnalytics(state, range)) });
  });
  router.get('/members', async (req, res) => {
    const range = parseAnalyticsRange(req.query);
    res.json(await read(state => membersAnalytics(state, range, req.query)));
  });
  router.get('/members/:id', async (req, res) => {
    const range = parseAnalyticsRange(req.query);
    const id = String(req.params.id);
    res.json({ data: await read(state => memberAnalytics(state, id, range, req.query),id) });
  });
  return router;
}
