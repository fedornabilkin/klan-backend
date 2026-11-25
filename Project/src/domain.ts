import { assignPublicIds } from './user-ids.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Activity, Entity, Resource, User } from './shared/contracts.js';
import { parseTagFilter } from './shared/tag-names.js';
import { isCalendarDate, normalizeProfileEntries, profileEntryText } from './shared/profile-entries.js';
import { formatProfileName, latestProfileDate, normalizeTelegramUsername } from './shared/profile-identity.js';
import type { DatabaseState, RecordUsernameChange } from './repository.js';
import { forbidden, HttpError, notFound } from './errors.js';
import { hasCapability, requireCapability } from './access.js';

export const resources = ['users', 'events', 'teams', 'challenges', 'news', 'feedback', 'books', 'rules'] as const;
const shortText = z.string().trim().min(1).max(120);
const stringList = z.array(z.string().trim().min(1).max(250)).max(40);
const entryText = z.string().min(1).max(1000).refine(value => value.trim().length > 0, 'Текст не может быть пустым');
const profileEntrySchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/),
  text: entryText,
  date: z.string().refine(isCalendarDate, 'Укажите корректную календарную дату YYYY-MM-DD').nullable(),
}).strict();
const profileEntriesSchema = z.array(z.union([entryText, profileEntrySchema])).max(100).superRefine((entries, context) => {
  const ids = new Set<string>();
  entries.forEach((entry, index) => {
    if (typeof entry === 'string') return;
    if (ids.has(entry.id)) context.addIssue({ code: 'custom', path: [index, 'id'], message: 'Идентификаторы записей не должны повторяться' });
    ids.add(entry.id);
  });
});
const tagSchema = z.object({ id: z.string().min(1).max(80), name: shortText });
const statusSchema = z.enum(['active', 'archived', 'open', 'in_progress', 'resolved', 'closed', 'draft', 'published', 'completed', 'upcoming']);
const categorySchema = z.string().trim().max(120);
const tagsSchema = z.array(tagSchema).max(30);
const locationSchema = z.object({
  city: z.string().trim().max(100), country: z.string().trim().max(100),
  lat: z.number().min(-90).max(90).nullable().default(null),
  lng: z.number().min(-180).max(180).nullable().default(null),
}).refine(location => (location.lat === null) === (location.lng === null), {
  message: 'Укажите обе координаты или оставьте обе пустыми', path: ['lng'],
});
const profileDateSchema = z.string().refine(isCalendarDate, 'Укажите корректную календарную дату ГГГГ-ММ-ДД')
  .refine(value => value <= latestProfileDate(), 'Дата не может быть в будущем').nullable().optional();
export const profileSchema = z.object({
  name: shortText.optional(), bio: z.string().trim().max(5000).optional(), location: locationSchema.optional(),
  firstName: shortText.optional(), lastName: z.string().trim().max(120).optional(), middleName: z.string().trim().max(120).optional(),
  username: z.string().transform(normalizeTelegramUsername).refine(value => !value || /^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(value), 'Укажите Telegram username: 5–32 латинских символа, цифры и подчёркивания, начиная с буквы').nullable().optional(),
  birthDate: profileDateSchema, clanJoinedOn: profileDateSchema,
  callsign: z.string().trim().max(120).optional(),
  facts: profileEntriesSchema.optional(), interests: stringList.optional(), achievements: profileEntriesSchema.optional(),
  tags: z.array(tagSchema).max(30).optional(),
}).strict().superRefine((profile, context) => {
  const fields = ['firstName', 'middleName', 'lastName'] as const;
  if (!fields.some(field => profile[field] !== undefined)) return;
  if (!fields.every(field => profile[field] !== undefined)) {
    fields.filter(field => profile[field] === undefined).forEach(field => context.addIssue({ code: 'custom', path: [field], message: 'Передайте имя, фамилию и отчество вместе' }));
    return;
  }
  const name = formatProfileName({ firstName: profile.firstName!, middleName: profile.middleName!, lastName: profile.lastName! });
  if (name.length > 120) context.addIssue({ code: 'custom', path: ['firstName'], message: 'Полное имя должно содержать не больше 120 символов' });
  if (profile.name !== undefined && profile.name !== name) context.addIssue({ code: 'custom', path: ['name'], message: 'Полное имя должно совпадать с именем, отчеством и фамилией' });
});
const adminProfileSchema = profileSchema.safeExtend({
  usernameChangeComment: z.string().trim().max(1000, 'Комментарий должен содержать не более 1000 символов').optional(),
});
export const entitySchema = z.object({
  title: shortText, description: z.string().trim().max(5000), status: statusSchema.default('active'),
  category: categorySchema.default(''), content: z.string().max(30000).optional(),
  tags: tagsSchema.default([]), location: locationSchema.optional(),
  schedule: z.object({ start: z.iso.datetime({ offset: true }), end: z.iso.datetime({ offset: true }) }).optional(),
  motto: z.string().trim().max(200).optional(), goal: z.object({ target: z.number().positive().max(1e9), unit: shortText, scope: z.literal('participant').optional() }).optional(),
  capacity: z.number().int().positive().max(100000).nullish(),
  organizer: z.union([z.object({ userId: shortText }).strict(), z.object({ name: shortText }).strict()]).nullish(),
}).strict();
// PATCH must not apply creation defaults to omitted fields.
const entityPatchSchema = entitySchema.partial().extend({ status: statusSchema.optional(), category: categorySchema.optional(), tags: tagsSchema.optional() });
export const querySchema = z.object({
  page: z.coerce.number().int().min(1).max(100000).default(1), limit: z.coerce.number().int().min(1).max(100).default(12),
  q: z.string().max(200).default(''), sort: z.enum(['name', '-name', 'createdAt', '-createdAt']).default('-createdAt'),
  status: z.string().max(60).optional(), category: z.string().max(120).optional(), tag: z.string().max(1500).optional(), city: z.string().max(120).optional(),
});
export type Query = z.infer<typeof querySchema>;

export const importedFactPrefix = 'PCM (из исходного файла):';
export function communityFact(entry: User['facts'][number]) {
  return !profileEntryText(entry).startsWith(importedFactPrefix);
}

export function profileWithMemberships(user: User, activeTeams: NonNullable<User['activeTeams']>, stats: User['stats']): User {
  // Import provenance includes an authentication identity and stays server-side.
  const { communityImport: _communityImport, historicalImport: _historicalImport, importProvenance: _source, ...profile } = user as User & { communityImport?: unknown; historicalImport?: unknown; importProvenance?: unknown };
  return { ...profile,
    activeTeams, stats,
    facts: normalizeProfileEntries((user.facts ?? []).filter(communityFact), `${user.id}:facts`),
    achievements: normalizeProfileEntries(user.achievements, `${user.id}:achievements`),
  };
}
export function hydrateUser(state: DatabaseState, user: User): User {
  const teams = state.entities.filter(team => team.type === 'teams' && team.status === 'active' && team.participants.some(participant => participant.user.id === user.id))
    .map(team => ({ id: team.id, ...(team.publicId && { publicId: team.publicId }), title: team.title, description: team.description, memberCount: new Set(team.participants.map(participant => participant.user.id)).size }));
  return profileWithMemberships(user, teams, {
    events: state.entities.filter(e => e.type === 'events' && e.participants.some(p => p.user.id === user.id)).length,
    challenges: state.entities.filter(e => e.type === 'challenges' && e.participants.some(p => p.user.id === user.id)).length,
    books: state.entities.filter(e => e.type === 'books' && e.readers?.some(reader => reader.id === user.id)).length,
  });
}
export function hydrateEntity(state: DatabaseState, entity: Entity): Entity {
  // A month's daily results can reference the same participant thousands of times.
  const usersById = new Map(state.users.map(user => [user.id, user]));
  const hydratedUsers = new Map<string, User>();
  const getUser = (user: User) => {
    let hydrated = hydratedUsers.get(user.id);
    if (!hydrated) {
      hydrated = hydrateUser(state, usersById.get(user.id) ?? user);
      hydratedUsers.set(user.id, hydrated);
    }
    return hydrated;
  };
  const { historicalImport: _historicalImport, ...publicEntity } = entity as Entity & { historicalImport?: unknown };
  const organizer = entity.organizer && 'userId' in entity.organizer ? usersById.get(entity.organizer.userId) : undefined;
  return { ...publicEntity, organizerUser: organizer && getUser(organizer), participants: entity.participants.map(p => ({ ...p, user: getUser(p.user), team: p.team ? { id: p.team.id, title: state.entities.find(e => e.id === p.team?.id)?.title ?? p.team.title } : undefined })),
    author: entity.author ? getUser(entity.author) : undefined,
    readers: entity.readers?.map(getUser), results: entity.results?.map(result => ({ ...result, user: getUser(result.user) })),
    pendingResults: entity.pendingResults?.map(result => ({ ...result, user: getUser(result.user) })),
  };
}
export function getEntity(state: DatabaseState, resource: string, id: string): Entity {
  const entity = state.entities.find(e => (e.id === id || String(e.publicId ?? '') === id) && e.type === resource);
  if (!entity) throw notFound();
  return entity;
}
export function getUser(state: DatabaseState, id: string): User {
  const direct = state.users.find(user => user.id === id);
  if (direct) return direct;
  const publicId = /^\d+$/.test(id) ? Number(id) : NaN;
  const user = Number.isSafeInteger(publicId) && publicId > 0 ? state.users.find(candidate => candidate.publicId === publicId) : undefined;
  if (!user) throw notFound();
  return user;
}
export function visibleState(state: DatabaseState, actor: User): DatabaseState {
  if (hasCapability(actor, 'content.manage')) return state;
  const draftPaths = new Set(state.entities.filter(entity => entity.status === 'draft').flatMap(entity => [`/${entity.type}/${entity.id}`,`/${entity.type}/${entity.publicId}`]));
  return { ...state, entities: state.entities.filter(entity => entity.status !== 'draft'), activities: state.activities.filter(activity => !activity.target || !draftPaths.has(activity.target.path)) };
}
export function activeTeamMembers(entities: Entity[]): Set<string> {
  return new Set(entities.filter(e => e.type === 'teams' && e.status === 'active')
    .flatMap(team => team.participants.map(p => p.user.id)));
}

function activityIdentity(state: DatabaseState, user: Activity['actor'] | User) {
  const { id, publicId, firstName, lastName, name, initials, color, callsign } = user;
  const hasActiveTeam = state.entities.some(e => e.type === 'teams' && e.status === 'active' && e.participants.some(p => p.user.id === id));
  return { id, publicId, firstName, lastName, name, initials, color, callsign, hasActiveTeam };
}
export function publicActivity(state: DatabaseState, activity: Activity): Activity {
  const user = state.users.find(u => u.id === activity.actor.id);
  const actor = { ...activity.actor, ...activityIdentity(state, user ?? activity.actor) };
  if (!activity.target) return {...activity,actor};
  const [,type,id] = activity.target.path.split('/');
  if (type === 'users') {
    const target = state.users.find(u => u.id === id || String(u.publicId) === id);
    return { ...activity, actor, target: target ? { title:target.name, path:`/users/${target.publicId ?? target.id}`,
      user:activityIdentity(state,target) } : activity.target };
  }
  const record = state.entities.find(e => e.type === type && e.id === id);
  return { ...activity,actor,target:record?.publicId ? {...activity.target,path:`/${type}/${record.publicId}`} : activity.target };
}
export function requireAdmin(actor: User) { if (actor.role !== 'admin') throw forbidden(); }

export type SearchUser = Pick<User, 'id' | 'name' | 'username' | 'callsign' | 'bio' | 'location' | 'interests' | 'facts' | 'achievements' | 'tags' | 'joinedAt'>;
function searchText(record: SearchUser | Entity) {
  return 'name' in record
    ? [record.name, record.username, record.callsign, record.bio, record.location?.city, record.location?.country, ...(record.interests ?? []), ...(record.facts ?? []).filter(communityFact).map(profileEntryText), ...(record.achievements ?? []).map(profileEntryText), ...(record.tags ?? []).map(t => t.name)].join(' ')
    : [record.title, record.description, record.category, record.location?.city, ...record.tags.map(t => t.name)].join(' ');
}
export function filtered<T extends SearchUser | Entity>(rows: T[], query: Query): T[] {
  const tags = parseTagFilter(query.tag ?? '');
  const terms = query.q.toLocaleLowerCase('ru').trim().split(/\s+/).filter(Boolean);
  return rows.filter(row => {
    if (!terms.length) return true;
    const text = searchText(row).toLocaleLowerCase('ru');
    return terms.every(term => text.includes(term));
  })
    .filter(row => !query.status || ('status' in row && row.status === query.status))
    .filter(row => !query.category || ('category' in row && row.category === query.category))
    .filter(row => !query.city || row.location?.city.toLocaleLowerCase('ru') === query.city.toLocaleLowerCase('ru'))
    .filter(row => tags.every(tag => row.tags.some(t => t.id === tag || t.name.toLocaleLowerCase('ru') === tag.toLocaleLowerCase('ru'))))
    .sort((a, b) => {
      const key = query.sort.replace('-', '');
      const value = (row: SearchUser | Entity) => key === 'name' ? ('name' in row ? row.name : row.title) : ('joinedAt' in row ? row.joinedAt : row.createdAt);
      const order = naturalRussian.compare(value(a), value(b));
      return (query.sort.startsWith('-') ? -order : order) || a.id.localeCompare(b.id);
    });
}
const naturalRussian = new Intl.Collator('ru', { numeric: true });
export function paginate<T>(rows: T[], query: Pick<Query, 'page' | 'limit'>) {
  return { data: rows.slice((query.page - 1) * query.limit, query.page * query.limit), meta: { page: query.page, limit: query.limit, total: rows.length, pages: Math.max(1, Math.ceil(rows.length / query.limit)) } };
}
export function addActivity(state: DatabaseState, actor: User, action: string, target?: Activity['target']): Activity {
  const item: Activity = { id: randomUUID(), actor: { id: actor.id, publicId: actor.publicId, name: actor.name, initials: actor.initials, color: actor.color, role: actor.role }, action, target, createdAt: new Date().toISOString() };
  state.activities.unshift(item);
  return item;
}
export function canonicalTags(state: DatabaseState, tags: { id: string; name: string }[]) {
  return [...new Set(tags.map(t => t.id))].map(id => {
    const existing = state.tags.find(tag => tag.id === id);
    if (!existing) throw new HttpError(400, 'UNKNOWN_TAG', 'Сначала создайте тег в общем справочнике');
    return existing;
  });
}
export function updateProfile(state: DatabaseState, id: string, input: unknown, actor: User,
  options?: { recordUsernameChange: RecordUsernameChange; adminEditor?: boolean }): User {
  const user = getUser(state, id);
  const adminEdit = actor.id !== user.id || options?.adminEditor;
  if (adminEdit) requireCapability(actor, 'members.manage');
  const { usernameChangeComment, ...values } = adminEdit ? adminProfileSchema.parse(input)
    : { ...profileSchema.parse(input), usernameChangeComment: undefined };
  const username = values.username;
  const previous = normalizeTelegramUsername(user.username ?? '') || null;
  const changeUsername = adminEdit && username !== undefined && (username || null) !== previous;
  if (username && state.users.some(candidate => candidate.id !== user.id && candidate.username && normalizeTelegramUsername(candidate.username).toLowerCase() === username.toLowerCase())) {
    throw new HttpError(409, 'USERNAME_TAKEN', 'Этот Telegram username уже указан в другом профиле');
  }
  if (values.tags) values.tags = canonicalTags(state, values.tags);
  if (values.facts) values.facts = normalizeProfileEntries(values.facts, `${user.id}:facts`);
  if (values.achievements) values.achievements = normalizeProfileEntries(values.achievements, `${user.id}:achievements`);
  if (changeUsername) {
    if (!usernameChangeComment) throw new HttpError(400, 'USERNAME_COMMENT_REQUIRED', 'Укажите причину изменения логина Telegram');
    if (!options) throw new Error('Missing transaction audit writer');
    options.recordUsernameChange({ adminId: actor.id, userId: user.id, previous, next: username || null,
      comment: usernameChangeComment, createdAt: new Date().toISOString() });
  }
  if (values.firstName !== undefined) {
    values.name = formatProfileName({ firstName: values.firstName, middleName: values.middleName!, lastName: values.lastName! });
  } else if (values.name !== undefined && values.name !== user.name) {
    delete user.firstName;
    delete user.middleName;
    delete user.lastName;
  }
  // A contact handle can be edited without changing the authentication identity.
  // All other validations finish before any persisted profile field is changed.
  const { username: _username, ...profileValues } = values;
  Object.assign(user, profileValues);
  if (username !== undefined) {
    if (username) user.username = username;
    else delete user.username;
  }
  user.initials = user.name.split(/\s+/).slice(0, 2).map(part => part[0]).join('').toUpperCase();
  return hydrateUser(state, user);
}
function validateEntity(state: DatabaseState, entity: Entity, original?: Entity) {
  if (entity.organizer) {
    if (entity.type !== 'events') throw new HttpError(400, 'EVENT_ONLY', 'Организатора можно указать только для мероприятия');
    if ('userId' in entity.organizer) entity.organizer = { userId: getUser(state, entity.organizer.userId).id };
  }
  if (entity.type === 'teams' && !['active', 'archived'].includes(entity.status)) throw new HttpError(400, 'INVALID_TEAM_STATUS', 'Для команды допустимы статусы «активна» и «архив»');
  if (entity.type === 'feedback' && !['open', 'in_progress', 'resolved', 'closed'].includes(entity.status)) throw new HttpError(400, 'INVALID_FEEDBACK_STATUS', 'Некорректный статус предложения');
  if (entity.schedule && Date.parse(entity.schedule.end) < Date.parse(entity.schedule.start)) throw new HttpError(400, 'INVALID_SCHEDULE', 'Окончание должно быть после начала');
  if (['events', 'challenges'].includes(entity.type) && !entity.schedule) throw new HttpError(400, 'SCHEDULE_REQUIRED', 'Укажите даты проведения');
  if (entity.type === 'challenges' && !entity.goal) throw new HttpError(400, 'GOAL_REQUIRED', 'Укажите цель на одного участника');
  if (entity.type === 'challenges' && entity.category === 'attendance' && !Number.isInteger(entity.goal?.target))
    throw new HttpError(400, 'INVALID_ATTENDANCE_GOAL', 'Укажите целое число посещений на одного участника');
  if (entity.type === 'challenges' && entity.category !== 'distance' && !Number.isInteger(entity.goal?.target)
    && !(original && original.category === entity.category && original.goal?.target === entity.goal?.target))
    throw new HttpError(400, 'INVALID_CHALLENGE_GOAL', 'Укажите целое число для цели');
  if (entity.capacity && entity.capacity < entity.participants.length) throw new HttpError(409, 'CAPACITY_TOO_SMALL', 'Лимит меньше текущего числа участников');
  if (entity.type === 'teams' && entity.status === 'active' && original?.status !== 'active') {
    const conflict = state.entities.some(team => team.type === 'teams' && team.id !== entity.id && team.status === 'active' && team.participants.some(p => entity.participants.some(other => other.user.id === p.user.id)));
    if (conflict) throw new HttpError(409, 'ACTIVE_TEAM_EXISTS', 'У участников уже есть другая активная команда');
  }
  if (entity.type === 'challenges' && entity.schedule && entity.results?.some(r => r.date < entity.schedule!.start.slice(0, 10) || r.date > entity.schedule!.end.slice(0, 10))) throw new HttpError(409, 'RESULTS_OUTSIDE_SCHEDULE', 'Новые даты исключают существующие результаты');
  if (entity.type === 'challenges' && (entity.results?.length || entity.pendingResults?.length) && original && (entity.category !== original.category || entity.goal?.unit !== original.goal?.unit)) throw new HttpError(409, 'CHALLENGE_METRIC_LOCKED', 'Нельзя менять тип или единицу измерения челленджа после добавления результатов');
  if (entity.type === 'challenges' && entity.category === 'attendance' && entity.results?.some(result => ![0, 1].includes(result.value))) throw new HttpError(409, 'INVALID_ATTENDANCE_RESULTS', 'Существующие результаты несовместимы с отметкой посещения');
}
export function createEntity(state: DatabaseState, resource: Entity['type'], input: unknown, actor: User): Entity {
  if (resource !== 'feedback') requireCapability(actor, 'content.manage');
  const values = entitySchema.parse(input);
  if (resource === 'feedback' && (!hasCapability(actor, 'content.manage') || values.status === 'active')) values.status = 'open';
  const entity: Entity = { ...values, id: randomUUID(), type: resource, createdAt: new Date().toISOString(), participants: [], author: actor, tags: canonicalTags(state, values.tags) };
  if (resource === 'books') entity.readers = [];
  if (resource === 'challenges') {
    entity.results = [];
    if (entity.goal) entity.goal.scope = 'participant';
  }
  validateEntity(state, entity);
  state.entities.push(entity);
  assignPublicIds(state);
  return hydrateEntity(state, entity);
}
export function editEntity(state: DatabaseState, resource: Entity['type'], id: string, input: unknown, actor: User): Entity {
  const original = getEntity(state, resource, id);
  if (!(resource === 'feedback' && original.author?.id === actor.id)) requireCapability(actor, 'content.manage');
  const values = entityPatchSchema.parse(input);
  if (resource === 'feedback' && !hasCapability(actor, 'content.manage') && values.status !== undefined) throw forbidden();
  if (values.tags) values.tags = canonicalTags(state, values.tags);
  if (resource === 'challenges' && values.goal) values.goal.scope = 'participant';
  const entity = { ...original, ...values };
  validateEntity(state, entity, original);
  Object.assign(original, entity);
  return hydrateEntity(state, original);
}
export function joinEntity(state: DatabaseState, resource: string, id: string, actor: User, input: unknown) {
  const { teamId } = z.object({ teamId: z.string().min(1).max(80).optional() }).strict().parse(input ?? {});
  const entity = getEntity(state, resource, id);
  if (!['events', 'teams', 'challenges'].includes(resource)) throw notFound();
  if (['archived', 'closed', 'completed', 'draft'].includes(entity.status)) throw new HttpError(409, 'REGISTRATION_CLOSED', 'Запись закрыта');
  if (entity.schedule && Date.parse(entity.schedule.end) < Date.now()) throw new HttpError(409, 'REGISTRATION_CLOSED', 'Событие уже завершилось');
  if (entity.participants.some(p => p.user.id === actor.id)) return hydrateEntity(state, entity);
  if (entity.capacity && entity.participants.length >= entity.capacity) throw new HttpError(409, 'FULL', 'Свободных мест больше нет');
  if (resource === 'teams') {
    const other = state.entities.find(e => e.type === 'teams' && e.status === 'active' && e.id !== entity.id && e.participants.some(p => p.user.id === actor.id));
    if (other) throw new HttpError(409, 'ACTIVE_TEAM_EXISTS', `Вы уже состоите в активной команде «${other.title}»`);
  }
  let team: { id: string; title: string } | undefined;
  if (teamId) {
    if (resource !== 'challenges') throw new HttpError(400, 'INVALID_TEAM', 'Командное участие доступно в челленджах');
    const existing = getEntity(state, 'teams', teamId);
    if (existing.status !== 'active' || !existing.participants.some(p => p.user.id === actor.id)) throw forbidden();
    team = { id: existing.id, title: existing.title };
  }
  entity.participants.push({ user: getUser(state, actor.id), ...(team ? { team } : {}) });
  return hydrateEntity(state, entity);
}
export function leaveEntity(state: DatabaseState, resource: string, id: string, actor: User) {
  const entity = getEntity(state, resource, id);
  if (!['events', 'teams', 'challenges'].includes(resource)) throw notFound();
  if (entity.status === 'draft' && !hasCapability(actor, 'content.manage')) throw notFound();
  if (resource === 'teams' && entity.status === 'archived') throw new HttpError(409, 'TEAM_ARCHIVED', 'Состав архивной команды сохраняется в истории');
  if (resource === 'challenges' && (entity.results?.some(result => result.user.id === actor.id) || entity.pendingResults?.some(result => result.user.id === actor.id))) throw new HttpError(409, 'RESULTS_EXIST', 'Участие с результатами сохраняется в истории челленджа');
  entity.participants = entity.participants.filter(p => p.user.id !== actor.id);
  return hydrateEntity(state, entity);
}
export function setResult(state: DatabaseState, id: string, actor: User, input: unknown, now = new Date()) {
  const values = z.object({ date: z.iso.date(), value: z.number().nonnegative().max(1e7) }).strict().parse(input);
  const entity = getEntity(state, 'challenges', id);
  const participation = entity.participants.find(p => p.user.id === actor.id);
  if (!participation) throw new HttpError(403, 'JOIN_REQUIRED', 'Сначала присоединитесь к челленджу');
  if (!entity.schedule || Date.parse(entity.schedule.end) <= now.getTime() || ['completed', 'archived', 'closed', 'draft'].includes(entity.status)) throw new HttpError(409, 'CHALLENGE_FINISHED', 'Челлендж завершён, редактирование закрыто');
  if (Date.parse(entity.schedule.start) > now.getTime()) throw new HttpError(409, 'CHALLENGE_NOT_STARTED', 'Челлендж ещё не начался');
  if (values.date < entity.schedule.start.slice(0, 10) || values.date > entity.schedule.end.slice(0, 10) || values.date > now.toISOString().slice(0, 10)) throw new HttpError(400, 'INVALID_RESULT_DATE', 'Дата должна находиться в периоде челленджа и не быть в будущем');
  if (entity.category === 'attendance' && ![0, 1].includes(values.value)) throw new HttpError(400, 'INVALID_ATTENDANCE', 'Для отметки посещения используйте 0 или 1');
  if (entity.category !== 'distance' && !Number.isInteger(values.value)) throw new HttpError(400, 'INVALID_CHALLENGE_RESULT', 'Укажите целый результат');
  entity.results ??= [];
  const previous = entity.results.find(result => result.user.id === actor.id && result.date === values.date);
  if (previous) previous.value = values.value;
  else entity.results.push({ user: getUser(state, actor.id), ...values, ...(participation.team ? { team: participation.team } : {}) });
  return hydrateEntity(state, entity);
}

export function listResource(state: DatabaseState, resource: Resource, query: Query) {
  if (resource === 'users') { const response = paginate(filtered(state.users, query), query); return { ...response, data: response.data.map(user => hydrateUser(state, user)) }; }
  const response = paginate(filtered(state.entities.filter(e => e.type === resource), query), query);
  return { ...response, data: response.data.map(entity => hydrateEntity(state, entity)) };
}
