import assert from 'node:assert/strict';
import test from 'node:test';
import { createAuth, hashToken, type AuthDependencies } from './auth.js';
import { emptyState, MemoryRepository } from './repository.js';
import type { Config } from './config.js';
import type { User } from './shared/contracts.js';

const user: User = { id: 'telegram-member', name: 'Участник', role: 'member', bio: '', initials: 'У', color: '#f97316', location: { city: '', country: '', lat: 0, lng: 0 }, tags: [], facts: [], interests: [], achievements: [], stats: { events: 0, challenges: 0, books: 0 }, joinedAt: '2026-11-11T00:00:00.000Z' };
const base: Config = { demo: false, production: false, port: 0, origin: 'http://localhost', botInternalSecret: 'security-test-secret-'.repeat(2), telegramGroups: ['-1001', '-1002'], adminTelegramIds: [], sessionTtlMs: 3600000, membershipTtlMs: 15000, telegramGroupLevels: { '-1002': 'moderator' } };

test('Existing session is downgraded when elevated group is left and revoked when all memberships end', async () => {
  let clock = Date.parse('2026-11-11T12:00:00Z');
  const memberships = new Set(['-1001', '-1002']);
  const dependencies: AuthDependencies = {
    now: () => clock,
    telegramRequest: async <T>(_method: string, payload: object) => ({ status: memberships.has((payload as { chat_id: string }).chat_id) ? 'member' : 'left' }) as T,
  };
  const state = emptyState(); state.users.push(user); state.telegramUsers['12345'] = user.id;
  const token = 'a'.repeat(64); state.sessions[hashToken(token)] = { userId: user.id, expiresAt: new Date(clock + 3600000).toISOString() };
  const repo = new MemoryRepository(state); const auth = createAuth(repo, base, undefined, dependencies);
  assert.equal((await auth.userFromCookie(`klan_session=${token}`))?.access?.level, 'moderator');
  memberships.delete('-1002'); clock += 15001;
  assert.equal((await auth.userFromCookie(`klan_session=${token}`))?.access?.level, 'member');
  memberships.clear(); clock += 15001;
  assert.equal(await auth.userFromCookie(`klan_session=${token}`), undefined);
  assert.equal(await repo.read(value => value.sessions[hashToken(token)]), undefined);
});

test('A Telegram outage fails closed after the cached membership expires', async () => {
  let clock = Date.parse('2026-11-11T12:00:00Z'); let outage = false;
  const state = emptyState(); state.users.push(user); state.telegramUsers['12345'] = user.id;
  const token = 'b'.repeat(64); state.sessions[hashToken(token)] = { userId: user.id, expiresAt: new Date(clock + 3600000).toISOString() };
  const dependencies: AuthDependencies = { now: () => clock, telegramRequest: async <T>() => { if (outage) throw new Error('Secret vendor details must not escape'); return { status: 'member' } as T; } };
  const repo = new MemoryRepository(state); const auth = createAuth(repo, base, undefined, dependencies);
  assert.ok(await auth.userFromCookie(`klan_session=${token}`));
  outage = true; clock += 15001;
  assert.equal(await auth.userFromCookie(`klan_session=${token}`), undefined);
});

test('Bot denies outsiders, stale links and non-private commands without creating users or sessions', async () => {
  const now = Date.parse('2026-11-11T12:00:00Z');
  const state = emptyState(); const id = 'a'.repeat(48);
  state.authRequests[id] = { browserHash: hashToken('browser'), expiresAt: new Date(now + 10000).toISOString(), status: 'pending' };
  const repo = new MemoryRepository(state);
  const sent: object[] = [];
  const dependencies: AuthDependencies = { now: () => now, telegramRequest: async <T>(method: string, payload: object) => { if (method === 'sendMessage') sent.push(payload); return (method === 'getChatMember' ? { status: 'left' } : {}) as T; } };
  const auth = createAuth(repo, base, undefined, dependencies);
  const message = { from: { id: 12345, first_name: 'Посторонний' }, chat: { id: 12345, type: 'private' }, text: `/start ${id}` };
  await auth.handleTelegramUpdate({ update_id: 1, message });
  assert.equal(sent.length, 1);
  assert.equal(await repo.read(value => value.users.length), 0);
  assert.equal(await repo.read(value => Object.keys(value.sessions).length), 0);
  await auth.handleTelegramUpdate({ update_id: 2, message: { ...message, chat: { id: -1001, type: 'supergroup' } } });
  assert.equal(sent.length, 1);
  await repo.write(value => { value.authRequests[id]!.expiresAt = new Date(now - 1).toISOString(); });
  await auth.handleTelegramUpdate({ update_id: 3, message });
  assert.equal(sent.length, 2);
  assert.equal(await repo.read(value => value.users.length), 0);
});

test('Admin ID receives no session access when it belongs to no permitted group', async () => {
  const state = emptyState(); state.users.push({ ...user, role: 'admin' }); state.telegramUsers['12345'] = user.id;
  const token = 'c'.repeat(64); state.sessions[hashToken(token)] = { userId: user.id, expiresAt: new Date(Date.now() + 3600000).toISOString() };
  const repo = new MemoryRepository(state);
  const auth = createAuth(repo, { ...base, adminTelegramIds: ['12345'] }, undefined, { telegramRequest: async <T>() => ({ status: 'kicked' }) as T });
  assert.equal(await auth.userFromCookie(`klan_session=${token}`), undefined);
});
