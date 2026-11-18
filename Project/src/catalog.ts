import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import type { Activity, User } from './shared/contracts.js';
import type { CatalogEntry, CatalogKind, CatalogListResponse, CatalogUsage } from './shared/catalog.js';
import type { DatabaseState, Repository } from './repository.js';
import { addActivity, paginate } from './domain.js';
import { requireCapability } from './access.js';
import { HttpError, notFound } from './errors.js';

export const catalogKindSchema = z.enum(['tags', 'items']);
export function normalizeCatalogName(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/gu, ' ');
}
const nameKey = (name: string) => normalizeCatalogName(name).toLocaleLowerCase('ru');
export const catalogInputSchema = z.object({
  name: z.string().transform(normalizeCatalogName).pipe(z.string().min(1).max(80)
    .refine(value => !/[\u0000-\u001f\u007f]/u.test(value), 'Название содержит недопустимые символы')),
}).strict();
export const catalogQuerySchema = z.object({
  q: z.string().trim().max(200).default(''),
  sort: z.enum(['name', '-name', 'usage', '-usage']).default('name'),
  page: z.coerce.number().int().min(1).max(100000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

function embeddedUsers(entity: DatabaseState['entities'][number]): User[] {
  return [
    ...entity.participants.map(participant => participant.user),
    ...(entity.results ?? []).map(result => result.user),
    ...(entity.readers ?? []),
    ...(entity.author ? [entity.author] : []),
  ];
}

/** Counts live references, ignoring stale copies of a still-existing user's profile. */
export function catalogUsage(state: DatabaseState, kind: CatalogKind, id: string): CatalogUsage {
  if (kind === 'tags') {
    const users = state.users.filter(user => user.tags.some(tag => tag.id === id)).length;
    const knownUsers = new Set(state.users.map(user => user.id));
    const entities = state.entities.filter(entity => entity.tags.some(tag => tag.id === id)
      || embeddedUsers(entity).some(user => !knownUsers.has(user.id) && user.tags.some(tag => tag.id === id))).length;
    return { users, entities, participants: 0, total: users + entities };
  }
  let entities = 0;
  let participants = 0;
  for (const entity of state.entities) {
    const references = entity.participants.filter(participant => participant.items?.some(item => item.id === id)).length;
    if (references) entities++;
    participants += references;
  }
  return { users: 0, entities, participants, total: participants };
}

function catalogEntry(state: DatabaseState, kind: CatalogKind, id: string): CatalogEntry {
  const entry = state[kind].find(value => value.id === id);
  if (!entry) throw notFound();
  return { id: entry.id, name: entry.name, usage: catalogUsage(state, kind, id) };
}

export function listCatalog(state: DatabaseState, kind: CatalogKind, input: unknown, actor: User): CatalogListResponse {
  requireCapability(actor, 'catalog.manage');
  const query = catalogQuerySchema.parse(input);
  const all = state[kind].map(entry => catalogEntry(state, kind, entry.id));
  const terms = nameKey(query.q).split(' ').filter(Boolean);
  const rows = all.filter(entry => terms.every(term => nameKey(entry.name).includes(term)));
  const ascending = query.sort.startsWith('-') ? -1 : 1;
  const byUsage = query.sort.replace('-', '') === 'usage';
  rows.sort((left, right) => {
    const order = byUsage ? left.usage.total - right.usage.total : left.name.localeCompare(right.name, 'ru', { numeric: true });
    return ascending * order || left.name.localeCompare(right.name, 'ru') || left.id.localeCompare(right.id);
  });
  const used = all.filter(entry => entry.usage.total > 0).length;
  return { ...paginate(rows, query), summary: { entries: all.length, used, unused: all.length - used } };
}

function assertUniqueName(state: DatabaseState, kind: CatalogKind, name: string, exceptId?: string) {
  if (state[kind].some(entry => entry.id !== exceptId && nameKey(entry.name) === nameKey(name))) {
    throw new HttpError(409, 'CATALOG_DUPLICATE', kind === 'tags' ? 'Тег с таким названием уже существует' : 'Предмет с таким названием уже существует');
  }
}

/** Shared with member-facing creation so names use the same canonical spelling. */
export function findOrCreateCatalogEntry(state: DatabaseState, kind: CatalogKind, input: unknown) {
  const { name } = catalogInputSchema.parse(input);
  const existing = state[kind].find(entry => nameKey(entry.name) === nameKey(name));
  if (existing) return existing;
  const entry = { id: randomUUID(), name };
  state[kind].push(entry);
  return entry;
}

export function createCatalogEntry(state: DatabaseState, kind: CatalogKind, input: unknown, actor: User): CatalogEntry {
  requireCapability(actor, 'catalog.manage');
  const { name } = catalogInputSchema.parse(input);
  assertUniqueName(state, kind, name);
  const entry = findOrCreateCatalogEntry(state, kind, { name });
  return catalogEntry(state, kind, entry.id);
}

export function renameCatalogEntry(state: DatabaseState, kind: CatalogKind, id: string, input: unknown, actor: User): CatalogEntry {
  requireCapability(actor, 'catalog.manage');
  const { name } = catalogInputSchema.parse(input);
  const entry = state[kind].find(value => value.id === id);
  if (!entry) throw notFound();
  assertUniqueName(state, kind, name, id);
  entry.name = name;
  if (kind === 'tags') {
    const renameTags = (user: User) => { for (const tag of user.tags) if (tag.id === id) tag.name = name; };
    state.users.forEach(renameTags);
    for (const entity of state.entities) {
      for (const tag of entity.tags) if (tag.id === id) tag.name = name;
      embeddedUsers(entity).forEach(renameTags);
    }
  } else {
    for (const entity of state.entities) for (const participant of entity.participants) {
      for (const item of participant.items ?? []) if (item.id === id) item.name = name;
    }
  }
  return catalogEntry(state, kind, id);
}

export function deleteCatalogEntry(state: DatabaseState, kind: CatalogKind, id: string, actor: User): { success: true } {
  requireCapability(actor, 'catalog.manage');
  const entry = catalogEntry(state, kind, id);
  if (entry.usage.total > 0) {
    throw new HttpError(409, 'CATALOG_IN_USE', kind === 'tags'
      ? 'Тег используется в профилях или записях. Сначала уберите его из них; переименование доступно без удаления.'
      : 'Предмет включён в списки снаряжения. Сначала уберите его из списков; переименование сохраняет количество.');
  }
  if (kind === 'tags') {
    // Profiles are authoritative; remove obsolete denormalized copies only after checking live references.
    for (const entity of state.entities) for (const user of embeddedUsers(entity)) {
      user.tags = user.tags.filter(tag => tag.id !== id);
    }
  }
  state[kind] = state[kind].filter(value => value.id !== id);
  return { success: true };
}

export function createCatalogRouter(repo: Repository, notify: (resource: string, activity?: Activity) => void): Router {
  const router = Router();
  router.use((req, _res, next) => { requireCapability(req.user!, 'catalog.manage'); next(); });
  router.get('/:kind', async (req, res) => {
    const kind = catalogKindSchema.parse(req.params.kind);
    res.json(await repo.read(state => listCatalog(state, kind, req.query, req.user!)));
  });
  // Catalog names occur in many entity types; one wildcard avoids a burst of repeated dashboard reloads.
  const notifyChanges = (activity: Activity) => notify('*', activity);
  router.post('/:kind', async (req, res) => {
    const kind = catalogKindSchema.parse(req.params.kind);
    const outcome = await repo.write(state => {
      const data = createCatalogEntry(state, kind, req.body, req.user!);
      return { data, activity: addActivity(state, req.user!, `${kind === 'tags' ? 'добавил тег' : 'добавил предмет'} «${data.name}»`) };
    });
    notifyChanges(outcome.activity);
    res.status(201).json({ data: outcome.data });
  });
  router.patch('/:kind/:id', async (req, res) => {
    const kind = catalogKindSchema.parse(req.params.kind);
    const outcome = await repo.write(state => {
      const data = renameCatalogEntry(state, kind, String(req.params.id), req.body, req.user!);
      return { data, activity: addActivity(state, req.user!, `${kind === 'tags' ? 'переименовал тег' : 'переименовал предмет'} в «${data.name}»`) };
    });
    notifyChanges(outcome.activity);
    res.json({ data: outcome.data });
  });
  router.delete('/:kind/:id', async (req, res) => {
    const kind = catalogKindSchema.parse(req.params.kind);
    const outcome = await repo.write(state => {
      const data = deleteCatalogEntry(state, kind, String(req.params.id), req.user!);
      return { data, activity: addActivity(state, req.user!, kind === 'tags' ? 'удалил неиспользуемый тег' : 'удалил неиспользуемый предмет') };
    });
    notifyChanges(outcome.activity);
    res.json({ data: outcome.data });
  });
  return router;
}
