import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Entity } from './shared/contracts.js';
import { createSeed } from './seed.js';
import { hydrateUser, updateProfile } from './domain.js';
import { MemoryRepository } from './repository.js';
import { createAuth } from './auth.js';
import { createApp } from './app.js';
import type { Config } from './config.js';

const identity = { firstName: ' Роман ', middleName: ' Сергеевич ', lastName: ' Смирнов ', callsign: ' Фёдор Набилкин ', username: ' @fedornabilkin ', birthDate: '1988-02-29' };
const config: Config = { port: 0, demo: true, production: false, origin: 'http://localhost:5173', telegramGroups: [], adminTelegramIds: [], sessionTtlMs: 60_000, demoUserId: 'user-1', demoAccessLevel: 'admin' };

test('identity saves name parts, callsign, username and birth date together without altering Telegram bindings', () => {
  const state = createSeed(); const user = state.users[1]!;
  state.telegramUsers['12345'] = user.id;
  const saved = updateProfile(state, user.id, identity, user);
  assert.equal(saved.name, 'Роман Сергеевич Смирнов');
  assert.equal(saved.firstName, 'Роман');
  assert.equal(saved.middleName, 'Сергеевич');
  assert.equal(saved.lastName, 'Смирнов');
  assert.equal(saved.callsign, 'Фёдор Набилкин');
  assert.equal(saved.username, 'fedornabilkin');
  assert.equal(saved.birthDate, '1988-02-29');
  assert.equal(saved.initials, 'РС');
  assert.deepEqual(state.telegramUsers, { '12345': user.id });
  updateProfile(state, user.id, { username: null, birthDate: null }, user);
  assert.equal(user.username, undefined);
  assert.equal(user.birthDate, null);
  assert.deepEqual(state.telegramUsers, { '12345': user.id });
  updateProfile(state, user.id, { username: 'another_handle' }, user);
  updateProfile(state, user.id, { username: ' ' }, user);
  assert.ok(!Object.hasOwn(user, 'username'));
});

test('invalid identity changes reject the whole patch before modifying a profile', () => {
  const state = createSeed(); const user = state.users[1]!;
  const original = structuredClone(user);
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  for (const invalid of [
    { firstName: 'Роман' }, { middleName: '' }, { lastName: '' },
    { firstName: '', middleName: '', lastName: 'Смирнов' },
    { firstName: 'Р'.repeat(61), middleName: '', lastName: 'С'.repeat(60) },
    { ...identity, name: 'Другое имя' },
    ...['1989-02-29', '2000-04-31', '0000-01-01', '1988-2-29', '1988-02-29T00:00:00Z', tomorrow, ''].map(birthDate => ({ birthDate })),
    ...['ab', '1abcdef', 'a-bcdef', '@@abcdef', 'тестовый', 'a'.repeat(33)].map(username => ({ username })),
  ]) {
    assert.throws(() => updateProfile(state, user.id, { bio: 'Must not persist', ...invalid }, user));
    assert.deepEqual(user, original);
  }
  assert.equal(updateProfile(state, user.id, { firstName: 'Роман', middleName: '', lastName: '' }, user).name, 'Роман');
  assert.equal(updateProfile(state, user.id, { birthDate: new Date().toISOString().slice(0, 10) }, user).birthDate, new Date().toISOString().slice(0, 10));
});

test('legacy names remain untouched on reads and unrelated saves, and legacy rename clears split parts', () => {
  const state = createSeed(); const user = state.users[1]!;
  const name = user.name;
  assert.equal(hydrateUser(state, user).firstName, undefined);
  assert.equal(hydrateUser(state, user).birthDate, undefined);
  updateProfile(state, user.id, { bio: 'О себе' }, user);
  assert.equal(user.name, name);
  assert.equal(user.firstName, undefined);
  updateProfile(state, user.id, identity, user);
  updateProfile(state, user.id, { name: user.name }, user);
  assert.equal(user.firstName, 'Роман');
  updateProfile(state, user.id, { name: 'Другое полное имя' }, user);
  assert.equal(user.name, 'Другое полное имя');
  for (const key of ['firstName', 'middleName', 'lastName']) assert.ok(!Object.hasOwn(user, key));
  assert.equal(user.birthDate, '1988-02-29');
});

test('identity edits retain ownership rules, cannot set access, and reject case-insensitive username collisions', () => {
  const state = createSeed(); const user = state.users[1]!;
  const before = structuredClone(user);
  assert.throws(() => updateProfile(state, user.id, identity, state.users[2]!), { code: 'FORBIDDEN' });
  assert.throws(() => updateProfile(state, user.id, { ...identity, role: 'admin' }, user));
  assert.throws(() => updateProfile(state, user.id, { ...identity, activeTeams: [] }, user));
  assert.throws(() => updateProfile(state, user.id, { ...identity, username: ` @${state.users[0]!.username!.toUpperCase()} ` }, user), { code: 'USERNAME_TAKEN' });
  assert.deepEqual(user, before);
  assert.equal(updateProfile(state, user.id, identity, state.users[0]!).firstName, 'Роман');
  assert.equal(updateProfile(state, user.id, { username: 'FEDORNABILKIN' }, user).username, 'FEDORNABILKIN');
});

test('concurrent claims cannot assign the same contact username to two profiles', async () => {
  const initial = createSeed(); const repo = new MemoryRepository(initial);
  const outcomes = await Promise.allSettled(initial.users.slice(1, 3).map(user => repo.write(state => updateProfile(state, user.id, { username: 'unique_handle' }, user))));
  assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(await repo.read(state => state.users.filter(user => user.username === 'unique_handle').length), 1);
  assert.equal((outcomes.find(result => result.status === 'rejected') as PromiseRejectedResult).reason.code, 'USERNAME_TAKEN');
});

test('profile includes active team membership beyond the first 100 teams and counts unique members', () => {
  const state = createSeed(); const user = state.users[1]!;
  const team = (id: string, status: string, memberIds: number[]): Entity => ({ id, title: id, type: 'teams', status, description: `О команде ${id}`, category: '', tags: [], createdAt: '2026-01-01T00:00:00Z', participants: memberIds.map(index => ({ user: state.users[index]! })) });
  state.entities = Array.from({ length: 110 }, (_, index) => team(`unrelated-${index}`, 'active', [2]));
  state.entities.push(team('archived-member', 'archived', [1]), team('active-member', 'active', [1, 2, 2]), team('second-active', 'active', [1]));
  state.entities.push({ ...team('event', 'active', [1]), type: 'events' });
  assert.deepEqual(hydrateUser(state, user).activeTeams, [
    { id: 'active-member', title: 'active-member', description: 'О команде active-member', memberCount: 2 },
    { id: 'second-active', title: 'second-active', description: 'О команде second-active', memberCount: 1 },
  ]);
  assert.equal(user.activeTeams, undefined, 'membership remains derived, not persisted');
  assert.deepEqual(hydrateUser(state, state.users[3]!).activeTeams, []);
});

test('Telegram authentication uses immutable ID bindings despite profile username changes', async () => {
  const state = createSeed(); const user = state.users[1]!;
  state.telegramUsers['12345'] = user.id;
  updateProfile(state, user.id, { username: 'contact_handle' }, user);
  const existingRequest = 'a'.repeat(48); const unrelatedRequest = 'b'.repeat(48);
  for (const id of [existingRequest, unrelatedRequest]) state.authRequests[id] = { browserHash: 'test', expiresAt: new Date(Date.now() + 60000).toISOString(), status: 'pending' };
  const repo = new MemoryRepository(state);
  const auth = createAuth(repo, { ...config, botInternalSecret: 'test-service-secret-'.repeat(3), telegramGroups: ['-100123'] }, undefined, { telegramRequest: async <T>() => ({ status: 'member' }) as T });
  await auth.handleTelegramUpdate({ update_id: 1, message: { from: { id: 98765, first_name: 'Another', username: 'contact_handle' }, chat: { id: 98765, type: 'private' }, text: `/start ${unrelatedRequest}` } });
  await repo.read(current => {
    assert.equal(current.telegramUsers['12345'], user.id);
    assert.notEqual(current.telegramUsers['98765'], user.id, 'matching a contact username cannot claim another account');
    assert.equal(current.authRequests[unrelatedRequest]!.userId, current.telegramUsers['98765']);
  });
  await auth.handleTelegramUpdate({ update_id: 2, message: { from: { id: 12345, first_name: 'Renamed', username: 'official_handle' }, chat: { id: 12345, type: 'private' }, text: `/start ${existingRequest}` } });
  await repo.read(current => {
    assert.equal(current.authRequests[existingRequest]!.userId, user.id);
    assert.equal(current.users.find(candidate => candidate.id === user.id)!.username, 'official_handle');
    assert.equal(current.telegramUsers['12345'], user.id);
  });
});

test('profile export and import preserve structured identity fields', async t => {
  const repo = new MemoryRepository(createSeed());
  const { app } = createApp(repo, config);
  const server = createServer(app).listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const login = await fetch(`${base}/auth/demo`, { method: 'POST', headers: { origin: config.origin, 'content-type': 'application/json' }, body: '{}' });
  assert.equal(login.status, 200);
  const headers = { cookie: login.headers.getSetCookie()[0]!.split(';')[0]!, origin: config.origin, 'content-type': 'application/json' };
  const saved = await fetch(`${base}/users/me`, { method: 'PATCH', headers, body: JSON.stringify(identity) });
  assert.equal(saved.status, 200);
  const exported = await (await fetch(`${base}/users/me/export`, { headers })).json();
  const profile = exported.data.profile;
  assert.equal(profile.firstName, 'Роман');
  assert.equal(profile.lastName, 'Смирнов');
  assert.equal(profile.middleName, 'Сергеевич');
  assert.equal(profile.birthDate, '1988-02-29');
  assert.equal(profile.username, 'fedornabilkin');
  assert.equal(profile.activeTeams, undefined);
  const imported = await fetch(`${base}/users/me/import`, { method: 'POST', headers, body: JSON.stringify({ profile }) });
  assert.equal(imported.status, 200);
  assert.equal((await imported.json()).data.name, 'Роман Сергеевич Смирнов');
});
