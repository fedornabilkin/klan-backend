import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import express, { type ErrorRequestHandler } from 'express';
import { createBotIngress } from './bot-ingress.js';
import { createApp } from './app.js';
import { MemoryRepository } from './repository.js';
import type { TelegramUpdate } from './auth.js';
import { readConfig, type Config } from './config.js';

const secret = 'unit-test-service-secret-'.repeat(3);
const update = { update_id: 1, message: { message_id: 55, date: 0, from: { id: 12345, first_name: 'Test' }, chat: { id: 12345, type: 'private' }, text: '/start' } };

test('bot ingress requires the service secret, rejects browsers and validates updates', async t => {
  const received: TelegramUpdate[] = [];
  const app = express(); app.use(express.json());
  app.use('/internal/telegram', createBotIngress(secret, async body => { received.push(body); }));
  const errors: ErrorRequestHandler = (error, _req, res, _next) => { res.status(error.status ?? 400).json({ error: { code: error.code ?? 'VALIDATION' } }); };
  app.use(errors);
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/internal/telegram/updates`;
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${secret}` };
  const send = (body: unknown, extra = headers) => fetch(url, { method: 'POST', headers: extra, body: JSON.stringify(body) });
  assert.equal((await send(update, { ...headers, authorization: 'Bearer wrong' })).status, 401);
  assert.equal((await send(update, { ...headers, origin: 'http://localhost' } as typeof headers)).status, 401);
  assert.equal((await send({ ...update, update_id: -1 })).status, 400);
  assert.equal((await send({ ...update, message: { ...update.message, from: { id: '12345' } } })).status, 400);
  const response = await send(update);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), null);
  assert.equal((await response.json()).data.accepted, true);
  assert.equal((await send(update)).status, 200);
  assert.equal(received.length, 1, 'retried delivery is acknowledged without duplicate handling');
  assert.equal('message_id' in received[0]!.message!, false, 'unused Telegram fields are discarded');
});

test('bot ingress retries failed processing and shares concurrent processing', async t => {
  let attempts = 0;
  const app = express(); app.use(express.json());
  app.use('/internal/telegram', createBotIngress(secret, async () => { attempts++; if (attempts === 1) throw new Error('API unavailable'); }));
  const errors: ErrorRequestHandler = (_error, _req, res, _next) => { res.sendStatus(503); }; app.use(errors);
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/internal/telegram/updates`;
  const send = () => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` }, body: JSON.stringify(update) });
  assert.equal((await send()).status, 503);
  assert.deepEqual((await Promise.all([send(), send()])).map(response => response.status), [200, 200]);
  assert.equal(attempts, 2);
});

test('API bot endpoint is disabled without a secret and is separate from browser authentication', async t => {
  const config: Config = { port: 0, production: false, demo: true, origin: 'http://localhost:5173', telegramGroups: [], adminTelegramIds: [], sessionTtlMs: 60000, botInternalSecret: secret };
  const { app } = createApp(new MemoryRepository(), config);
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const response = await fetch(`${base}/internal/telegram/updates`, { method: 'POST', headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' }, body: JSON.stringify({ update_id: 1 }) });
  assert.equal(response.status, 200, 'service has no browser Origin or session cookie');
  assert.equal((await fetch(`${base}/api/users`)).status, 401, 'the service secret grants no browser session');

  const disabled = express(); disabled.use(express.json()); disabled.use('/internal/telegram', createBotIngress(undefined, async () => { assert.fail('disabled endpoint processed an update'); }));
  const errors: ErrorRequestHandler = (error, _req, res, _next) => { res.sendStatus(error.status ?? 500); }; disabled.use(errors);
  const disabledServer = disabled.listen(0, '127.0.0.1'); await once(disabledServer, 'listening');
  t.after(async () => { disabledServer.closeAllConnections(); await new Promise<void>(resolve => disabledServer.close(() => resolve())); });
  assert.equal((await fetch(`http://127.0.0.1:${(disabledServer.address() as AddressInfo).port}/internal/telegram/updates`, { method: 'POST', headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' }, body: JSON.stringify(update) })).status, 404);
});

test('production requires a strong service secret for the separate bot', () => {
  const env = { NODE_ENV: 'production', APP_ORIGIN: 'https://klan.example.org', DATABASE_URL: 'postgres://localhost/klan', TELEGRAM_GROUP_IDS: '-1001' };
  assert.throws(() => readConfig(env), /BOT_INTERNAL_SECRET/);
  assert.throws(() => readConfig({ ...env, BOT_INTERNAL_SECRET: 'short' }), /BOT_INTERNAL_SECRET/);
  assert.equal(readConfig({ ...env, BOT_INTERNAL_SECRET: secret }).botInternalSecret, secret);
});

for (const requireMembership of [false, true]) {
  test(`registered bot completes a browser login with group checks ${requireMembership ? 'on' : 'off'}`, { timeout: 8000 }, async t => {
    const origin = 'http://localhost:5173';
    const config = readConfig({
      APP_ORIGIN: origin, DATABASE_URL: 'postgres://localhost/klan',
      BOT_INTERNAL_SECRET: secret, TELEGRAM_REQUIRE_GROUP_MEMBERSHIP: String(requireMembership),
      TELEGRAM_GROUP_IDS: requireMembership ? '-1001' : '',
    });
    const { app } = createApp(new MemoryRepository(), config);
    const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
    t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const headers = { 'content-type': 'application/json', authorization: `Bearer ${secret}` };
    const service = (path: string, body: unknown, signal?: AbortSignal) => fetch(`${base}/internal/telegram/${path}`, {
      method: 'POST', headers, body: JSON.stringify(body), signal,
    });
    const authConfig = async () => (await (await fetch(`${base}/api/auth/config`)).json()).data;
    const startLogin = () => fetch(`${base}/api/auth/telegram/start`, {
      method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: '{}',
    });
    assert.equal((await authConfig()).botUsername, null);
    assert.equal((await startLogin()).status, 503);
    assert.equal((await service('commands', { id: 123, username: 'wrong/path' })).status, 400);
    const identity = { id: 123, username: 'discovered_test_bot' };
    const commandLoop = new AbortController();
    t.after(() => commandLoop.abort());
    const methods: string[] = [];
    const work = (async () => {
      while (!commandLoop.signal.aborted) {
        const response = await service('commands', identity, commandLoop.signal);
        assert.equal(response.status, 200);
        const { data: { commands } } = await response.json();
        for (const command of commands) {
          methods.push(command.method);
          const result = command.method === 'getChatMember' ? { ok: true, result: { status: 'member' } }
            : command.method === 'sendMessage' ? { ok: true, result: { message_id: 55 } } : { ok: true };
          if (command.method === 'sendMessage') {
            assert.match(command.payload.text, /Код подтверждения: \d{6}/);
            assert.deepEqual(command.payload.reply_markup.inline_keyboard[0].map((button: {text: string}) => button.text), ['Авторизоваться', 'Отклонить']);
          }
          assert.equal((await service('command-result', { botId: identity.id, id: command.id, response: result })).status, 204);
        }
      }
    })();
    // Abort errors are expected at shutdown. Test failures during the loop still fail the test.
    const workerDone = work.catch(error => { if (!commandLoop.signal.aborted) throw error; });
    t.after(() => workerDone);
    try {
      for (let index = 0; index < 30 && (await authConfig()).botUsername === null; index++) await delay(10);
      assert.equal((await authConfig()).botUsername, identity.username);
      const start = await startLogin();
      assert.equal(start.status, 200);
      const { data } = await start.json();
      assert.equal(new URL(data.botUrl).pathname, `/${identity.username}`);
      const browserCookie = start.headers.getSetCookie()[0]!.split(';')[0]!;
      const updateWithCode = { ...update, message: { ...update.message, text: `/start ${data.id}` } };
      assert.equal((await service('updates', updateWithCode)).status, 200);
      assert.equal((await service('updates', {
        update_id: update.update_id + 1,
        callback_query: { id: 'synthetic-callback', from: update.message.from, data: `ok:${data.id}`, message: update.message },
      })).status, 200);
      const status = await fetch(`${base}/api/auth/telegram/status/${data.id}`, { headers: { cookie: browserCookie } });
      assert.equal((await status.json()).data.status, 'approved');
      assert.ok(status.headers.getSetCookie().some(cookie => cookie.startsWith('klan_session=')));
      assert.deepEqual(methods, requireMembership
        ? ['sendMessage', 'answerCallbackQuery', 'getChatMember', 'editMessageText', 'getChatMember']
        : ['sendMessage', 'answerCallbackQuery', 'editMessageText']);
    } finally {
      commandLoop.abort();
      await workerDone;
    }
  });
}
