import test from 'node:test';
import assert from 'node:assert/strict';
import { createSeed } from './seed.js';
import { MemoryRepository } from './repository.js';
import { accessForLevel } from './access.js';
import { catalogUsage, createCatalogEntry, deleteCatalogEntry, findOrCreateCatalogEntry, listCatalog, renameCatalogEntry } from './catalog.js';

// JSON cloning deliberately breaks the seed's shared object references, as PostgreSQL JSONB does.
const fixture = () => JSON.parse(JSON.stringify(createSeed())) as ReturnType<typeof createSeed>;

test('catalog names normalize whitespace and Unicode; duplicates fail within a catalog only', () => {
  const state = fixture();
  const admin = state.users[0]!;
  const added = createCatalogEntry(state, 'tags', { name: '  Новый   тег  ' }, admin);
  assert.equal(added.name, 'Новый тег');
  assert.throws(() => createCatalogEntry(state, 'tags', { name: 'НОВЫЙ\tТЕГ' }, admin), { code: 'CATALOG_DUPLICATE' });
  assert.equal(createCatalogEntry(state, 'items', { name: 'Новый тег' }, admin).name, 'Новый тег');
  const unicode = createCatalogEntry(state, 'tags', { name: 'Ａpple' }, admin);
  assert.equal(unicode.name, 'Apple');
  assert.throws(() => createCatalogEntry(state, 'tags', { name: 'apple' }, admin), { code: 'CATALOG_DUPLICATE' });
  assert.throws(() => createCatalogEntry(state, 'tags', { name: '   ' }, admin));
  assert.throws(() => createCatalogEntry(state, 'items', { name: 'a'.repeat(81) }, admin));
  assert.throws(() => createCatalogEntry(state, 'items', { name: 'OK', role: 'admin' }, admin));
});

test('member-facing create reuses canonical catalog entries instead of duplicating them', () => {
  const state = fixture();
  const before = state.tags.length;
  const entry = findOrCreateCatalogEntry(state, 'tags', { name: '  поХОДы ' });
  assert.equal(entry.id, 'tag-1');
  assert.equal(state.tags.length, before);
});

test('tag rename updates profiles, entities, and independently stored embedded user snapshots', () => {
  const state = fixture();
  const entry = renameCatalogEntry(state, 'tags', 'tag-1', { name: 'Туризм' }, state.users[0]!);
  assert.equal(entry.name, 'Туризм');
  for (const user of state.users) for (const tag of user.tags) if (tag.id === 'tag-1') assert.equal(tag.name, 'Туризм');
  let seenSnapshots = 0;
  for (const entity of state.entities) {
    for (const tag of entity.tags) if (tag.id === 'tag-1') assert.equal(tag.name, 'Туризм');
    const users = [...entity.participants.map(value => value.user), ...(entity.results ?? []).map(value => value.user), ...(entity.readers ?? []), ...(entity.author ? [entity.author] : [])];
    for (const user of users) for (const tag of user.tags) if (tag.id === 'tag-1') { assert.equal(tag.name, 'Туризм'); seenSnapshots++; }
  }
  assert.ok(seenSnapshots > 10);
  assert.throws(() => renameCatalogEntry(state, 'tags', 'tag-1', { name: '  спорт ' }, state.users[0]!), { code: 'CATALOG_DUPLICATE' });
  assert.equal(state.tags.find(tag => tag.id === 'tag-1')!.name, 'Туризм');
});

test('item rename preserves participant quantities and usage counts count assignments, not quantity', () => {
  const state = fixture();
  const event = state.entities.find(entity => entity.id === 'event-1')!;
  const item = event.participants[0]!.items!.find(value => value.id === 'item-5')!;
  item.quantity = 12;
  event.participants[1]!.items!.push({ id: item.id, name: item.name, quantity: 3 });
  const entry = renameCatalogEntry(state, 'items', item.id, { name: 'Радиостанция' }, state.users[0]!);
  assert.deepEqual(entry.usage, { users: 0, entities: 1, participants: 2, total: 2 });
  assert.equal(item.name, 'Радиостанция');
  assert.equal(item.quantity, 12);
  assert.equal(event.participants[1]!.items!.find(value => value.id === item.id)!.quantity, 3);
});

test('referenced catalogs cannot be deleted and absent records return 404', () => {
  const state = fixture();
  const admin = state.users[0]!;
  assert.throws(() => deleteCatalogEntry(state, 'tags', 'tag-1', admin), { code: 'CATALOG_IN_USE', status: 409 });
  assert.throws(() => deleteCatalogEntry(state, 'items', 'item-1', admin), { code: 'CATALOG_IN_USE', status: 409 });
  const unused = createCatalogEntry(state, 'tags', { name: 'Неиспользуемый' }, admin);
  assert.deepEqual(deleteCatalogEntry(state, 'tags', unused.id, admin), { success: true });
  assert.ok(!state.tags.some(tag => tag.id === unused.id));
  assert.throws(() => renameCatalogEntry(state, 'tags', unused.id, { name: 'Новое' }, admin), { status: 404 });
  assert.throws(() => deleteCatalogEntry(state, 'items', 'absent', admin), { status: 404 });
});

test('obsolete snapshots do not falsely lock a detached tag and are cleaned on removal', () => {
  const state = fixture();
  const id = 'tag-1';
  for (const user of state.users) user.tags = user.tags.filter(tag => tag.id !== id);
  for (const entity of state.entities) entity.tags = entity.tags.filter(tag => tag.id !== id);
  const snapshot = state.entities.find(entity => entity.id === 'event-1')!.participants[0]!.user;
  assert.ok(snapshot.tags.some(tag => tag.id === id));
  assert.equal(catalogUsage(state, 'tags', id).total, 0);
  deleteCatalogEntry(state, 'tags', id, state.users[0]!);
  assert.ok(!snapshot.tags.some(tag => tag.id === id));
});

test('catalog administration rejects members and accepts only explicitly granted moderator capability', () => {
  const state = fixture();
  const member = state.users[1]!;
  assert.throws(() => listCatalog(state, 'tags', {}, member), { status: 403 });
  assert.throws(() => createCatalogEntry(state, 'tags', { name: 'No' }, member), { status: 403 });
  assert.throws(() => renameCatalogEntry(state, 'tags', 'tag-1', { name: 'No' }, member), { status: 403 });
  assert.throws(() => deleteCatalogEntry(state, 'items', 'item-7', member), { status: 403 });
  member.access = accessForLevel('moderator', 'telegram');
  assert.ok(createCatalogEntry(state, 'tags', { name: 'Модератор' }, member).id);
  assert.ok(listCatalog(state, 'tags', {}, member).meta.total > 0);
  member.access = accessForLevel('member', 'telegram');
  assert.throws(() => listCatalog(state, 'tags', {}, member), { status: 403 });
});

test('catalog search, stable pagination and usage sorting preserve unfiltered summary', () => {
  const state = fixture();
  const admin = state.users[0]!;
  const created = createCatalogEntry(state, 'tags', { name: 'Тестовый новый тег' }, admin);
  const found = listCatalog(state, 'tags', { q: 'НОВЫЙ  тестовый', limit: 1, page: 1 }, admin);
  assert.equal(found.meta.total, 1);
  assert.equal(found.data[0]!.id, created.id);
  assert.equal(found.summary.entries, state.tags.length);
  assert.equal(found.summary.unused, 1);
  const usage = listCatalog(state, 'items', { sort: '-usage', limit: 100 }, admin);
  assert.ok(usage.data[0]!.usage.total > 0);
  assert.equal(usage.data.at(-1)!.usage.total, 0);
  const first = listCatalog(state, 'tags', { limit: 2 }, admin);
  const second = listCatalog(state, 'tags', { page: 2, limit: 2 }, admin);
  assert.ok(first.data.every(a => second.data.every(b => b.id !== a.id)));
  assert.throws(() => listCatalog(state, 'tags', { page: 0 }, admin));
});

test('serialized catalog writes prevent concurrent duplicate creation', async () => {
  const state = fixture();
  const repo = new MemoryRepository(state);
  const results = await Promise.allSettled(['  Новый тег', 'НОВЫЙ   ТЕГ'].map(name => repo.write(draft => createCatalogEntry(draft, 'tags', { name }, state.users[0]!))));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(await repo.read(draft => draft.tags.filter(tag => tag.name.toLowerCase() === 'новый тег').length), 1);
});
