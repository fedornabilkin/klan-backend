import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from './app.js';
import { MemoryRepository, type Repository } from './repository.js';
import { createSeed } from './seed.js';
import { hashToken } from './auth.js';
import type { Config } from './config.js';

const config: Config = { port: 0, demo: false, production: false, origin: 'http://localhost:5173',
  botInternalSecret: 'admin-tests-service-secret-'.repeat(2), telegramGroups: ['-1001', '-1002', '-1003'],
  telegramGroupLevels: { '-1001': 'member', '-1002': 'moderator', '-1003': 'admin' },
  adminTelegramIds: [], sessionTtlMs: 60000 };

test('catalog and analytics HTTP routes enforce group capabilities and preserve references', async t => {
  const repo = new MemoryRepository(createSeed());
  const tokens = ['a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64)];
  await repo.write(state => {
    for (let index = 0; index < 3; index++) {
      state.telegramUsers[String(index + 1)] = `user-${index + 1}`;
      state.sessions[hashToken(tokens[index]!)] = { userId: `user-${index + 1}`, expiresAt: new Date(Date.now() + 60000).toISOString() };
    }
  });
  const { app } = createApp(repo, config, undefined, {
    async telegramRequest<T>(_method: string, payload: object) {
      const { chat_id, user_id } = payload as { chat_id: string; user_id: number };
      const group = ({ '1': '-1003', '2': '-1001', '3': '-1002' } as Record<string, string>)[String(user_id)];
      return { status: chat_id === group ? 'member' : 'left' } as T;
    },
  }, () => ['user-1', 'user-2']);
  const server = createServer(app).listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const headers = (index: number) => ({ cookie: `klan_session=${tokens[index]}`, origin: config.origin, 'content-type': 'application/json' });
  const request = (path: string, index: number, method = 'GET', body?: object) => fetch(`${base}${path}`, {
    method, headers: headers(index), ...(body ? { body: JSON.stringify(body) } : {}),
  });
  assert.equal((await fetch(`${base}/admin/analytics/community`)).status, 401);
  assert.equal((await request('/admin/analytics/community', 1)).status, 403);
  assert.equal((await request('/admin/catalogs/tags', 1)).status, 403);
  assert.equal((await request('/admin/analytics/community', 2)).status, 403);
  assert.equal((await request('/admin/analytics/community', 0)).status, 200);
  assert.equal((await fetch(base + '/admin/users?missing=telegram')).status, 401);
  for (const role of [1, 2]) assert.equal((await request('/admin/users?missing=telegram', role)).status, 403);
  assert.equal((await request('/admin/users?missing=unknown', 0)).status, 400);
  const unlinked = await (await request('/admin/users?missing=telegram&limit=2&page=2', 0)).json();
  assert.equal(unlinked.meta.total, 21);
  assert.equal(unlinked.data.length, 2);
  assert.ok(unlinked.data.every((u: { id: string }) => !['user-1', 'user-2', 'user-3'].includes(u.id)));
  const otherTeam = await repo.read(s => s.entities.find(e => e.type === 'teams' && e.status === 'active' && !e.participants.some(p => p.user.id === 'user-2'))!.id);
  assert.equal((await request(`/teams/${otherTeam}/join`, 1, 'DELETE')).status, 200);
  assert.equal(await repo.read(s => s.activities.some(a => a.actor.id === 'user-2' && a.action === 'отменил участие')), false);
  assert.equal((await request('/admin/analytics/community?from=2026-02-30', 0)).status, 400);
  assert.equal((await request('/admin/analytics/members/missing', 0)).status, 404);
  const members = await request('/admin/analytics/members?limit=5&page=2', 0);
  assert.equal(members.status, 200); assert.equal((await members.json()).data.length, 5);
  assert.equal((await fetch(base + '/presence/users')).status,401);
  const online = await (await request('/presence/users?page=2&limit=1',1)).json();
  assert.equal(online.meta.total,2); assert.equal(online.data[0].id,'user-2'); assert.ok(!('username' in online.data[0]));
  const geo = '/location-catalog/countries';
  assert.equal((await request(geo,1,'POST',{code:'ZZ',name:'Страна'})).status,403);
  assert.equal((await request(geo,0,'POST',{code:'ZZ',name:'Страна'})).status,201);
  assert.equal((await request(geo+'/ZZ',1,'PATCH',{code:'ZZ',name:'Имя'})).status,403);
  assert.equal((await request(geo+'/ZZ/cities',0,'POST',{name:'Маяк',region:'',lat:0,lng:0})).status,201);
  const places = await (await request('/location-catalog/cities?country=ZZ',1)).json();
  assert.equal(places.data[0].name,'Маяк'); assert.equal(places.data[0].lat,0);
  const created = await request('/admin/catalogs/tags', 2, 'POST', { name: '  QA   tag  ' });
  assert.equal(created.status, 201);
  const tag = (await created.json()).data;
  assert.equal(tag.name, 'QA tag');
  assert.equal((await request('/admin/catalogs/tags', 0, 'POST', { name: 'qa tag' })).status, 409);
  assert.equal((await request('/users/me', 1, 'PATCH', { tags: [tag] })).status, 200);
  const renamed = await request(`/admin/catalogs/tags/${tag.id}`, 2, 'PATCH', { name: 'Renamed tag' });
  assert.equal(renamed.status, 200);
  const profile = await (await request('/users/me', 1)).json();
  assert.equal(profile.data.tags[0].name, 'Renamed tag');
  assert.equal((await request(`/admin/catalogs/tags/${tag.id}`, 0, 'DELETE')).status, 409);
  assert.equal((await request('/users/me', 1, 'PATCH', { tags: [] })).status, 200);
  assert.equal((await request(`/admin/catalogs/tags/${tag.id}`, 2, 'DELETE')).status, 200);
  assert.equal((await request('/users/user-2', 2, 'PATCH', { bio: 'Unauthorized' })).status, 403);
  assert.equal((await request('/users/user-2', 2, 'DELETE')).status, 403);
  const draftResponse = await request('/news', 2, 'POST', { title: 'Moderator draft', description: 'Private until published', status: 'draft' });
  assert.equal(draftResponse.status, 201);
  const draft = (await draftResponse.json()).data;
  assert.equal((await request(`/news/${draft.id}`, 2)).status, 200);
  assert.equal((await request(`/news/${draft.id}`, 1)).status, 404);
  assert.equal((await request(`/news/${draft.id}`, 2, 'DELETE')).status, 200);
});

test('health reports database unavailability instead of a false healthy state', async t => {
  const memory = new MemoryRepository();
  const repo: Repository = { read: memory.read.bind(memory), write: memory.write.bind(memory), close: memory.close.bind(memory), ping: async () => { throw new Error('database offline'); } };
  const { app } = createApp(repo, config);
  const server = createServer(app).listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/health`);
  assert.equal(response.status, 503); assert.equal((await response.json()).data.status, 'unavailable');
});
