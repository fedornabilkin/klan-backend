import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import express, { type ErrorRequestHandler } from 'express';
import type { AddressInfo } from 'node:net';
import { createAuth, hashToken, isTelegramMember, readCookie, type AuthDependencies } from './auth.js';
import { emptyState, MemoryRepository } from './repository.js';
import { readConfig, type Config } from './config.js';
import type { User } from './shared/contracts.js';

const admin: User = {
  id: 'admin', name: 'Тестовый участник', role: 'admin', bio: '', initials: 'ТУ', color: '#f97316',
  location: { city: 'Москва', country: 'Россия', lat: 55.75, lng: 37.61 },
  tags: [], facts: [], interests: [], achievements: [], stats: { events: 0, challenges: 0, books: 0 },
  joinedAt: new Date().toISOString(),
};
const serviceSecret = 'test-service-secret-'.repeat(3);

async function fixture(overrides: Partial<Config> = {}, dependencies: AuthDependencies = {}) {
  const state = emptyState();
  state.users.push(admin);
  const repo = new MemoryRepository(state);
  const config: Config = {
    demo: true, production: false, port: 0, origin: 'http://localhost', telegramGroups: [], adminTelegramIds: [],
    demoUserId: admin.id, demoAccessLevel: 'admin',
    sessionTtlMs: 60_000, ...overrides,
  };
  const auth = createAuth(repo, config, undefined, { botUsername: () => 'test_bot', ...dependencies });
  const app = express();
  app.use(express.json());
  app.use('/api/auth', auth.router);
  const errors: ErrorRequestHandler = (error, _req, res, _next) => {
    res.status(error.status ?? 500).json({ error: { code: error.code, message: error.message } });
  };
  app.use(errors);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/auth`;
  return { repo, auth, base, close: () => { server.closeAllConnections(); return new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); } };
}

const telegramMessageId = 42;
const memberTelegram: AuthDependencies = { telegramRequest: async <T>(method: string) =>
  (method === 'sendMessage' ? { message_id: telegramMessageId } : { status: 'member' }) as T };

async function openInTelegram(auth: ReturnType<typeof createAuth>, id: string, user: { id: number; first_name: string }) {
  const chat = { id: user.id, type: 'private' };
  await auth.handleTelegramUpdate({ update_id: user.id, message: { from: user, chat, text: `/start ${id}` } });
  return (approve: boolean, messageId = telegramMessageId) => auth.handleTelegramUpdate({
    update_id: user.id + 1,
    callback_query: { id: 'synthetic-callback', from: user, data: `${approve ? 'ok' : 'no'}:${id}`, message: { message_id: messageId, chat } },
  });
}

test('Telegram membership excludes left, kicked and restricted non-members', () => {
  for (const status of ['creator', 'administrator', 'member']) assert.equal(isTelegramMember({ status }), true);
  assert.equal(isTelegramMember({ status: 'restricted', is_member: true }), true);
  for (const status of ['left', 'kicked', 'restricted', 'unknown']) assert.equal(isTelegramMember({ status }), false);
});

test('Cookie parsing handles malformed escapes without crashing', () => {
  assert.equal(readCookie('foo=1; klan_session=abc%3D; bar=2', 'klan_session'), 'abc=');
  assert.equal(readCookie('klan_session=%ZZ', 'klan_session'), undefined);
  assert.equal(readCookie('other=abc', 'klan_session'), undefined);
});

test('Demo creates hashed session and logout revokes it', async () => {
  const f = await fixture();
  try {
    const response = await fetch(`${f.base}/demo`, { method: 'POST' });
    assert.equal(response.status, 200);
    const header = response.headers.get('set-cookie')!;
    assert.match(header, /HttpOnly/i);
    assert.match(header, /SameSite=Lax/i);
    const cookie = header.split(';')[0]!;
    const token = cookie.split('=')[1]!;
    const state = await f.repo.read((value) => value);
    assert.ok(state.sessions[hashToken(token)]);
    assert.equal(state.sessions[token], undefined);
    await f.repo.write((value) => {
      value.entities.push({ id: 'joined-event', type: 'events', title: 'Поход', description: '', status: 'active',
        category: 'offline', tags: [], createdAt: new Date().toISOString(), participants: [{ user: admin }] });
    });
    const me = await fetch(`${f.base}/me`, { headers: { cookie } });
    assert.equal(me.status, 200);
    assert.equal((await me.json() as { data: User }).data.stats.events, 1, 'auth profile reflects current participation');
    assert.equal((await fetch(`${f.base}/logout`, { method: 'POST', headers: { cookie } })).status, 200);
    assert.equal((await fetch(`${f.base}/me`, { headers: { cookie } })).status, 401);
  } finally { await f.close(); }
});

test('Demo entry remains disabled in production even if incorrectly configured', async () => {
  const f = await fixture({ production: true, demo: true });
  try { assert.equal((await fetch(`${f.base}/demo`, { method: 'POST' })).status, 404); }
  finally { await f.close(); }
});

test('Production account-only sign-in still needs bot approval and respects explicit admin IDs', async () => {
  const config = readConfig({
    NODE_ENV: 'production', APP_ORIGIN: 'https://192.0.2.33:8443', DATABASE_URL: 'postgresql://db/klan',
    BOT_INTERNAL_SECRET: serviceSecret,
    TELEGRAM_REQUIRE_GROUP_MEMBERSHIP: 'false', TELEGRAM_ADMIN_IDS: '12345',
  });
  const telegramCalls: string[] = [];
  const f = await fixture(config, { telegramRequest: async <T>(method: string) => {
    telegramCalls.push(method);
    return { message_id: telegramMessageId } as T;
  } });
  try {
    for (const [telegramId, role] of [[64321, 'member'], [12345, 'admin']] as const) {
      const start = await fetch(`${f.base}/telegram/start`, { method: 'POST' });
      assert.equal(start.status, 200);
      const browserCookie = start.headers.getSetCookie()[0]!.split(';')[0]!;
      const { data } = await start.json();
      const statusUrl = `${f.base}/telegram/status/${data.id}`;
      const pending = await fetch(statusUrl, { headers: { cookie: browserCookie } });
      assert.equal((await pending.json()).data.status, 'pending');
      assert.equal(pending.headers.get('set-cookie'), null);

      const respond = await openInTelegram(f.auth, data.id, { id: telegramId, first_name: 'Участник' });
      assert.equal((await (await fetch(statusUrl, { headers: { cookie: browserCookie } })).json()).data.status, 'pending');
      await respond(true);
      const approved = await fetch(statusUrl, { headers: { cookie: browserCookie } });
      const body = await approved.json();
      assert.equal(body.data.status, 'approved');
      assert.equal(body.data.user.access.level, role);
      const session = approved.headers.getSetCookie().find(cookie => cookie.startsWith('__Host-klan_session='))!;
      assert.match(session, /; Secure/);
      assert.equal((await f.auth.userFromCookie(session.split(';')[0]))?.access?.level, role);
    }
    assert.deepEqual(telegramCalls, ['sendMessage', 'answerCallbackQuery', 'editMessageText', 'sendMessage', 'answerCallbackQuery', 'editMessageText']);
  } finally { await f.close(); }
});

test('Telegram shows the site and request time, then keeps the time of the first decision', async () => {
  for (const approve of [true, false]) {
    const origin = approve ? 'https://192.0.2.33:8443' : 'http://localhost:5173';
    let clock = Date.parse('2026-11-18T20:59:00Z');
    const messages: string[] = [];
    const f = await fixture({ origin, botInternalSecret: serviceSecret, telegramGroupMembershipRequired: false }, {
      now: () => clock,
      telegramRequest: async <T>(method: string, payload: object) => {
        if ('text' in payload) messages.push(String(payload.text));
        return { message_id: telegramMessageId } as T;
      },
    });
    try {
      const start = await fetch(`${f.base}/telegram/start`, { method: 'POST' });
      const { data } = await start.json();
      clock += 30_000;
      const respond = await openInTelegram(f.auth, data.id, { id: 12345, first_name: 'Участник' });
      const details = `Сайт: ${origin}\nВремя запроса: 18.11.2026, 23:59:00 МСК`;
      assert.ok(messages[0]?.includes(details));
      clock += 75_000;
      await respond(approve);
      assert.ok(messages[1]?.includes(details));
      const label = approve ? 'Время подтверждения' : 'Время отказа';
      assert.ok(messages[1]?.includes(`${label}: 19.11.2026, 00:00:45 МСК`));
      clock += 5_000;
      await respond(!approve);
      assert.equal(messages[2], messages[1]);
    } finally { await f.close(); }
  }
});

test('Demo selects only the configured profile and grants privileges only to its session', async () => {
  const romanId = 'pcm-2bd1e6d2-7b1f-447f-848b-f84cf302fa53';
  const f = await fixture({ demoUserId: romanId, demoAccessLevel: 'admin' });
  try {
    await f.repo.write(state => { state.users.push({ ...admin, id: romanId, publicId: 1, name: 'Роман Смирнов', role: 'member' }); });
    const response = await fetch(`${f.base}/demo?userId=admin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userId: admin.id, role: 'member' }) });
    assert.equal(response.status, 200);
    const user = (await response.json()).data;
    assert.equal(user.id, romanId);
    assert.equal(user.publicId, 1);
    assert.equal(user.role, 'admin');
    assert.equal(user.access.source, 'demo');
    assert.ok(user.access.capabilities.includes('members.manage'));
    const cookie = response.headers.getSetCookie()[0]!.split(';')[0]!;
    assert.equal((await f.auth.userFromCookie(cookie))?.access?.level, 'admin');
    const state = await f.repo.read(value => value);
    assert.equal(state.users.find(value => value.id === romanId)?.role, 'member');
    assert.equal(state.users.find(value => value.id === romanId)?.access, undefined);
    assert.equal(Object.values(state.sessions)[0]?.source, 'demo');
    const token = cookie.split('=')[1]!;
    const production = createAuth(f.repo, { demo: true, production: true, origin: 'https://klan.example.org', port: 0, telegramGroups: [], adminTelegramIds: [], sessionTtlMs: 60000, demoUserId: romanId, demoAccessLevel: 'admin' });
    assert.equal(await production.userFromCookie(`__Host-klan_session=${token}`), undefined);
  } finally { await f.close(); }
});

test('Demo never falls back to the first admin when the configured profile is missing', async () => {
  for (const demoUserId of [undefined, 'missing-profile']) {
    const f = await fixture({ demoUserId });
    try {
      const response = await fetch(`${f.base}/demo`, { method: 'POST' });
      assert.equal(response.status, 503);
      assert.equal(await f.repo.read(state => Object.keys(state.sessions).length), 0);
    } finally { await f.close(); }
  }
});

test('Demo access defaults to member and cannot elevate a Telegram session', async () => {
  const f = await fixture({ demoAccessLevel: undefined, botInternalSecret: serviceSecret, telegramGroups: ['-100123'] }, memberTelegram);
  try {
    const response = await fetch(`${f.base}/demo`, { method: 'POST' });
    assert.equal((await response.json()).data.access.level, 'member', 'stored admin role does not elevate default demo');
    const token = 'e'.repeat(64);
    await f.repo.write(state => {
      state.telegramUsers['12345'] = admin.id;
      state.sessions[hashToken(token)] = { userId: admin.id, expiresAt: new Date(Date.now() + 60000).toISOString(), source: 'telegram' };
    });
    const elevatedDemo = createAuth(f.repo, { demo: true, production: false, port: 0, origin: 'http://localhost', telegramGroups: ['-100123'], botInternalSecret: serviceSecret, adminTelegramIds: [], sessionTtlMs: 60000, demoUserId: admin.id, demoAccessLevel: 'admin' }, undefined, memberTelegram);
    const principal = await elevatedDemo.userFromCookie(`klan_session=${token}`);
    assert.equal(principal?.access?.source, 'telegram');
    assert.equal(principal?.access?.level, 'member');
  } finally { await f.close(); }
});

test('equivalent access returned in JSONB key order does not write the profile during reads', async () => {
  const f = await fixture({ botInternalSecret: serviceSecret, telegramGroupMembershipRequired: false });
  try {
    const token = '9'.repeat(64);
    await f.repo.write(state => {
      const user = state.users[0]!;
      user.role = 'member';
      user.access = { source: 'telegram', level: 'member', capabilities: ['community.read'] };
      state.telegramUsers['43210'] = user.id;
      state.sessions[hashToken(token)] = { userId: user.id, expiresAt: new Date(Date.now() + 60_000).toISOString() };
    });
    const revision = f.repo.revision;
    assert.equal((await f.auth.userFromCookie('klan_session=' + token))?.role, 'member');
    assert.equal(f.repo.revision, revision);
  } finally { await f.close(); }
});

test('Session expiry and fabricated cookies cannot authenticate', async () => {
  const f = await fixture();
  try {
    const expired = 'a'.repeat(64);
    await f.repo.write((state) => {
      state.sessions[hashToken(expired)] = { userId: admin.id, expiresAt: new Date(Date.now() - 1000).toISOString() };
    });
    assert.equal(await f.auth.userFromCookie(`klan_session=${expired}`), undefined);
    assert.equal(await f.auth.userFromCookie(`klan_session=${'b'.repeat(64)}`), undefined);
    assert.equal(await f.auth.userFromCookie('klan_session=__proto__'), undefined);
  } finally { await f.close(); }
});

test('Telegram approval belongs to its initiating browser and can be consumed once', async () => {
  const f = await fixture({ botInternalSecret: serviceSecret, telegramGroups: ['-100123'] }, memberTelegram);
  try {
    const start = await fetch(`${f.base}/telegram/start`, { method: 'POST' });
    assert.equal(start.status, 200);
    const browserCookie = start.headers.get('set-cookie')!.split(';')[0]!;
    const { data } = await start.json() as { data: { id: string; botUrl: string } };
    assert.match(data.botUrl, /https:\/\/t\.me\/test_bot\?start=[a-f0-9]{48}/);
    await f.repo.write((state) => {
      state.authRequests[data.id]!.status = 'approved';
      state.authRequests[data.id]!.userId = admin.id;
      state.telegramUsers['12345'] = admin.id;
    });
    const wrong = await fetch(`${f.base}/telegram/status/${data.id}`, { headers: { cookie: `klan_auth=${'c'.repeat(64)}` } });
    assert.equal(wrong.status, 403);
    const approved = await fetch(`${f.base}/telegram/status/${data.id}`, { headers: { cookie: browserCookie } });
    assert.equal(approved.status, 200);
    assert.equal((await approved.json() as { data: { status: string } }).data.status, 'approved');
    assert.match(approved.headers.get('set-cookie')!, /klan_session=/);
    const replay = await fetch(`${f.base}/telegram/status/${data.id}`, { headers: { cookie: browserCookie } });
    assert.equal((await replay.json() as { data: { status: string } }).data.status, 'expired');
  } finally { await f.close(); }
});

test('Session validation synchronizes configured Telegram admin role with stored profile', async () => {
  const f = await fixture({ demo: false, botInternalSecret: serviceSecret, telegramGroups: ['-100123'], adminTelegramIds: [] }, memberTelegram);
  try {
    const token = 'd'.repeat(64);
    await f.repo.write((state) => {
      state.telegramUsers['12345'] = admin.id;
      state.sessions[hashToken(token)] = { userId: admin.id, expiresAt: new Date(Date.now() + 60_000).toISOString() };
    });
    assert.equal((await f.auth.userFromCookie(`klan_session=${token}`))?.role, 'member');
    assert.equal(await f.repo.read((state) => state.users.find((user) => user.id === admin.id)?.role), 'member');
  } finally {
    await f.close();
  }
});

test('Production bot approval uses secure cookies, exposes computed access, and cannot be replayed', async () => {
  const f = await fixture({ demo: false, production: true, origin: 'https://klan.example.org', botInternalSecret: serviceSecret, telegramGroups: ['-100123'], telegramGroupLevels: { '-100123': 'moderator' } }, memberTelegram);
  try {
    const start = await fetch(`${f.base}/telegram/start`, { method: 'POST' });
    assert.equal(start.status, 200);
    const cookieHeader = start.headers.getSetCookie()[0]!;
    assert.match(cookieHeader, /^__Host-klan_auth=/);
    assert.match(cookieHeader, /; Secure/);
    assert.match(cookieHeader, /; HttpOnly/);
    const browserCookie = cookieHeader.split(';')[0]!;
    const { data } = await start.json();
    await (await openInTelegram(f.auth, data.id, { id: 12345, first_name: 'Новый участник' }))(true);
    const approved = await fetch(`${f.base}/telegram/status/${data.id}`, { headers: { cookie: browserCookie } });
    const body = await approved.json();
    assert.equal(body.data.status, 'approved');
    assert.equal(body.data.user.role, 'member');
    assert.equal(body.data.user.publicId, 1);
    assert.equal(body.data.user.access.level, 'moderator');
    assert.ok(body.data.user.access.capabilities.includes('catalog.manage'));
    assert.ok(!body.data.user.access.capabilities.includes('analytics.read'));
    assert.ok(!JSON.stringify(body.data.user.access).includes('-100123'));
    assert.match(approved.headers.getSetCookie().join(';'), /__Host-klan_session=.*; Secure/);
    assert.equal((await (await fetch(`${f.base}/telegram/status/${data.id}`, { headers: { cookie: browserCookie } })).json()).data.status, 'expired');
  } finally { await f.close(); }
});

test('Membership is rechecked between bot approval and session issuance', async () => {
  let member = true;
  const dependencies: AuthDependencies = { telegramRequest: async <T>(method: string) =>
    (method === 'sendMessage' ? { message_id: telegramMessageId } : { status: member ? 'member' : 'left' }) as T };
  const f = await fixture({ demo: false, botInternalSecret: serviceSecret, telegramGroups: ['-100123'] }, dependencies);
  try {
    const start = await fetch(`${f.base}/telegram/start`, { method: 'POST' });
    const browserCookie = start.headers.getSetCookie()[0]!.split(';')[0]!;
    const { data } = await start.json();
    await (await openInTelegram(f.auth, data.id, { id: 12345, first_name: 'Участник' }))(true);
    member = false;
    const denied = await fetch(`${f.base}/telegram/status/${data.id}`, { headers: { cookie: browserCookie } });
    assert.equal((await denied.json()).data.status, 'denied');
    assert.ok(!denied.headers.getSetCookie().some(value => value.startsWith('klan_session=')));
    assert.equal(await f.repo.read(state => Object.keys(state.sessions).length), 0);
  } finally { await f.close(); }
});

test('Telegram denial is final, forged button messages cannot approve, and the browser can cancel', async () => {
  const f = await fixture({ botInternalSecret: serviceSecret, telegramGroupMembershipRequired: false }, memberTelegram);
  try {
    const user = { id: 1234, first_name: 'Участник' };
    async function startRequest() {
      const start = await fetch(`${f.base}/telegram/start`, { method: 'POST' });
      const cookie = start.headers.getSetCookie()[0]!.split(';')[0]!;
      const { data } = await start.json();
      assert.match(data.displayCode, /^\d{6}$/);
      return { id: data.id as string, headers: { cookie } };
    }
    const request = await startRequest();
    const respond = await openInTelegram(f.auth, request.id, user);
    const url = `${f.base}/telegram/status/${request.id}`;
    await respond(true, 999);
    assert.equal((await (await fetch(url, { headers: request.headers })).json()).data.status, 'pending');
    await respond(false);
    await respond(true);
    const rejected = await fetch(url, { headers: request.headers });
    assert.equal((await rejected.json()).data.status, 'rejected');
    assert.equal(rejected.headers.getSetCookie().length, 0);
    const cancelled = await startRequest();
    const approveCancelled = await openInTelegram(f.auth, cancelled.id, user);
    assert.equal((await fetch(`${f.base}/telegram/cancel/${cancelled.id}`, { method: 'POST', headers: cancelled.headers })).status, 204);
    await approveCancelled(true);
    assert.equal((await (await fetch(`${f.base}/telegram/status/${cancelled.id}`, { headers: cancelled.headers })).json()).data.status, 'expired');
    assert.equal(await f.repo.read(state => Object.keys(state.telegramUsers).length), 0);
    assert.equal(await f.repo.read(state => Object.keys(state.sessions).length), 0);
  } finally { await f.close(); }
});
