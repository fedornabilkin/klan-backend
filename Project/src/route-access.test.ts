import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { createApp } from './app.js';
import { resources } from './domain.js';
import { MemoryRepository } from './repository.js';
import type { Config } from './config.js';

test('production HTTP routes require a session or the credential for their specific public operation', async t => {
  const config: Config = { production: true, demo: false, port: 0, origin: 'https://klan.example.org',
    botInternalSecret: 'route-access-test-secret-'.repeat(2), telegramGroups: [], adminTelegramIds: [], sessionTtlMs: 60000 };
  const repo = new MemoryRepository();
  const { app } = createApp(repo, config);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  const base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
  async function check(method: string, path: string, status: number, headers: Record<string,string> = {}, body = '{}') {
    const writes = !['GET', 'HEAD', 'DELETE'].includes(method);
    const response = await fetch(base + path, { method, headers: {
      ...(path.startsWith('/api/') && { origin: config.origin }), 'content-type': 'application/json', ...headers,
    }, ...(writes && { body }) });
    await response.arrayBuffer();
    assert.equal(response.status, status, method + ' ' + path);
  }
  const memberRoutes: Record<string,string[]> = {
    GET: ['auth/me', 'auth/sessions', 'users/me/export', 'presence/users', 'stats', 'dashboard', 'activity', 'geography',
      'location-catalog/countries', 'location-catalog/cities', 'admin/users', 'admin/access', 'admin/analytics/community',
      'admin/analytics/members', 'admin/analytics/members/1'],
    POST: ['auth/logout', 'users/me/import', 'users/1/tags', 'teams/1/members/2/exclude', 'admin/access/resolve',
      'location-catalog/countries', 'location-catalog/countries/RU/cities'],
    PUT: ['teams/1/members/2/role', 'events/1/items', 'challenges/1/results', 'books/1/read', 'feedback/1/like', 'admin/access'],
    PATCH: ['admin/users/1', 'location-catalog/countries/RU', 'location-catalog/countries/RU/cities/1'],
    DELETE: ['auth/sessions/others', 'auth/sessions/' + 'a'.repeat(64)],
  };
  for (const [method, routes] of Object.entries(memberRoutes))
    for (const route of routes) await check(method, '/api/' + route, 401);
  for (const resource of resources) {
    for (const method of ['GET', 'POST']) await check(method, '/api/' + resource, 401);
    for (const method of ['GET', 'PATCH', 'DELETE']) await check(method, '/api/' + resource + '/1', 401);
  }
  for (const resource of ['teams', 'events', 'challenges'])
    for (const method of ['POST', 'DELETE']) await check(method, '/api/' + resource + '/1/join', 401);
  for (const kind of ['tags', 'items']) {
    for (const method of ['GET', 'POST']) {
      await check(method, '/api/' + kind, 401);
      await check(method, '/api/admin/catalogs/' + kind, 401);
    }
    for (const method of ['PATCH', 'DELETE']) await check(method, '/api/admin/catalogs/' + kind + '/1', 401);
  }
  await check('GET', '/api/health', 200);
  await check('GET', '/api/auth/config', 200);
  await check('POST', '/api/auth/demo', 404);
  await check('POST', '/api/auth/telegram/start', 503); // No connected bot in this fixture.
  await check('GET', '/api/auth/telegram/status/' + 'a'.repeat(48), 400);
  await check('POST', '/api/auth/telegram/cancel/' + 'a'.repeat(48), 400);
  await check('GET', '/api/auth/config', 403, { 'sec-fetch-site': 'cross-site' });
  await check('GET', '/api/auth/config', 403, { 'sec-fetch-site': 'same-site', origin:'https://other.example.org' });
  await check('POST', '/api/auth/telegram/start', 403, { origin: 'https://other.example' });
  await check('POST', '/api/books', 401, {}, '{');
  for (const route of ['updates', 'commands', 'command-result']) await check('POST', '/internal/telegram/' + route, 401, {}, '{');
  assert.equal(repo.revision, 0);
});
