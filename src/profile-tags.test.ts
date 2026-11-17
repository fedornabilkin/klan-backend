import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { newTagNameError, normalizeTagName, tagNameKey } from './shared/tag-names.js';
import { createApp, type Broadcast } from './app.js';
import type { Config } from './config.js';
import { HttpError } from './errors.js';
import { createAndAssignProfileTag } from './profile-tags.js';
import { MemoryRepository } from './repository.js';
import { createSeed } from './seed.js';

function fixture() {
  const state = createSeed();
  state.users = state.users.slice(0, 2);
  state.entities = []; state.tags = []; state.activities = [];
  for (const user of state.users) { user.tags = []; delete user.access; }
  state.users[0]!.role = 'admin';
  state.users[1]!.role = 'member';
  return state;
}

test('new tags accept one word and useful technical names without automatically generalizing', () => {
  for (const name of ['спорт', '3D', 'IT', 'ИИ', 'C++', 'С++', 'C#', '3D-печать', 'Équipe', '中文', 'я'.repeat(80)]) {
    assert.equal(newTagNameError(name), undefined, name);
  }
  for (const name of ['', 'два слова', '-спорт', 'спорт-', 'спорт--туризм', '😊', 'https://t.me', '@foo', '3D/IT', 'я'.repeat(81)]) {
    assert.ok(newTagNameError(name), name);
  }
  assert.equal(normalizeTagName('  ３Ｄ  '), '3D');
  assert.equal(tagNameKey('  ЁлКИ  '), 'елки');
  const state = fixture();
  const user = state.users[1]!;
  const result = createAndAssignProfileTag(state, user.id, { name: '3D-печать' }, user);
  assert.equal(result.tags[0]!.name, '3D-печать');
});

test('members create tags on their own profile; editing another profile requires members.manage', () => {
  const state = fixture();
  const [admin, member] = state.users;
  const result = createAndAssignProfileTag(state, member!.id, { name: 'Робототехника' }, member!);
  assert.equal(result.tags[0]!.name, 'Робототехника');
  assert.equal(state.tags.length, 1);
  assert.throws(() => createAndAssignProfileTag(state, admin!.id, { name: 'Дизайн' }, member!), (error: unknown) => error instanceof HttpError && error.status === 403);
  assert.equal(state.tags.length, 1);
  assert.equal(createAndAssignProfileTag(state, member!.id, { name: 'Дизайн' }, admin!).tags.length, 2);
});

test('exact catalog matches ignore case and ё, remain idempotent and support legacy tag names', () => {
  const state = fixture();
  const member = state.users[1]!;
  state.tags = [{ id: 'trees', name: 'Ёлки' }, { id: 'boardgames', name: 'Настольные игры' }];
  createAndAssignProfileTag(state, member.id, { name: 'елКИ' }, member);
  createAndAssignProfileTag(state, member.id, { name: ' ЁЛКИ ' }, member);
  createAndAssignProfileTag(state, member.id, { name: 'настольные игры' }, member);
  assert.deepEqual(member.tags.map(tag => tag.id), ['trees', 'boardgames']);
  assert.equal(state.tags.length, 2);
  createAndAssignProfileTag(state, member.id, { name: 'Ёлочки' }, member);
  assert.equal(state.tags.length, 3);
});

test('concurrent duplicate requests create one catalog tag and assign it once', async () => {
  const initial = fixture();
  const member = initial.users[1]!;
  const repo = new MemoryRepository(initial);
  const results = await Promise.all(Array.from({ length: 12 }, (_, index) => repo.write(state => createAndAssignProfileTag(state, member.id, { name: index % 2 ? 'ЕЛКИ' : 'Ёлки' }, member))));
  const state = await repo.read(value => value);
  assert.equal(state.tags.length, 1);
  assert.equal(state.users[1]!.tags.length, 1);
  assert.ok(results.every(user => user.tags[0]!.id === state.tags[0]!.id));
});

test('the 30-tag limit is atomic and cannot leave an orphan catalog entry', async () => {
  const initial = fixture();
  initial.tags = Array.from({ length: 29 }, (_, index) => ({ id: `tag-${index}`, name: `Тег${index}` }));
  const member = initial.users[1]!;
  member.tags = [...initial.tags];
  const repo = new MemoryRepository(initial);
  const results = await Promise.allSettled(['Бег', 'Плавание'].map(name => repo.write(state => createAndAssignProfileTag(state, member.id, { name }, member))));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const failure = results.find(result => result.status === 'rejected');
  assert.ok(failure?.status === 'rejected' && failure.reason instanceof HttpError && failure.reason.code === 'PROFILE_TAG_LIMIT');
  const state = await repo.read(value => value);
  assert.equal(state.tags.length, 30);
  assert.equal(state.users[1]!.tags.length, 30);
  assert.ok(state.tags.every(tag => state.users[1]!.tags.some(selected => selected.id === tag.id)));
  await repo.write(draft => createAndAssignProfileTag(draft, member.id, { name: 'ТЕГ0' }, member));
  assert.equal((await repo.read(value => value.users[1]!.tags)).length, 30);
});

test('invalid tags and failed writes do not change profiles or the catalog', async () => {
  const initial = fixture();
  const member = initial.users[1]!;
  const repo = new MemoryRepository(initial);
  await assert.rejects(repo.write(state => createAndAssignProfileTag(state, member.id, { name: 'два слова' }, member)), (error: unknown) => error instanceof HttpError && error.code === 'INVALID_TAG_NAME');
  await assert.rejects(repo.write(state => {
    createAndAssignProfileTag(state, member.id, { name: 'Космос' }, member);
    throw new Error('abort transaction');
  }), /abort transaction/);
  assert.deepEqual(await repo.read(value => ({ tags: value.tags, selected: value.users[1]!.tags })), { tags: [], selected: [] });
});

test('profile tag API supports ordinary members, public IDs, permission checks and realtime invalidation', async t => {
  const initial = fixture();
  initial.users[1]!.publicId = 2;
  const config: Config = { port: 0, demo: true, production: false, origin: 'http://localhost:5173', telegramGroups: [], botToken: 'not-a-real-token', adminTelegramIds: [], sessionTtlMs: 60_000, demoUserId: 'user-2', demoAccessLevel: 'member' };
  const repo = new MemoryRepository(initial);
  const messages: Parameters<Broadcast>[0][] = [];
  const { app } = createApp(repo, config, message => messages.push(message));
  const server = createServer(app).listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const login = await fetch(`${base}/auth/demo`, { method: 'POST', headers: { origin: config.origin, 'content-type': 'application/json' }, body: '{}' });
  assert.equal(login.status, 200);
  const headers = { origin: config.origin, 'content-type': 'application/json', cookie: login.headers.getSetCookie()[0]!.split(';')[0]! };
  const post = (id: string, name: string) => fetch(`${base}/users/${id}/tags`, { method: 'POST', headers, body: JSON.stringify({ name }) });
  messages.length = 0;
  const created = await post('2', 'Робототехника');
  assert.equal(created.status, 200);
  assert.equal((await created.json()).data.tags[0].name, 'Робототехника');
  for (const resource of ['users', 'tags']) assert.ok(messages.some(message => message.type === 'invalidate' && message.resource === resource));
  assert.equal((await post('me', 'робототехника')).status, 200);
  assert.equal((await post('user-1', 'Дизайн')).status, 403);
  assert.equal((await post('me', 'два слова')).status, 400);
  assert.equal((await post('missing', 'Дизайн')).status, 404);
  assert.equal((await repo.read(state => state.tags)).length, 1);
});
