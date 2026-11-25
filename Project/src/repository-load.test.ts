import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { createSeed } from './seed.js';
import { PostgresRepository } from './repository.js';
import { sessionIdleMs } from './sessions.js';

test('stored access settings survive restart and are read by both PostgreSQL session paths', {skip:!process.env.TEST_DATABASE_URL}, async () => {
  const url = new URL(process.env.TEST_DATABASE_URL!);
  const schema = 'access_test_' + randomUUID().replaceAll('-','');
  const db = new pg.Client({connectionString:url.href});
  await db.connect();
  await db.query('CREATE SCHEMA ' + schema);
  url.searchParams.set('options','-c search_path=' + schema);
  const repo = new PostgresRepository(url.href);
  const reopened = new PostgresRepository(url.href);
  try {
    await repo.migrate();
    const [user] = createSeed().users;
    const policy = {revision:randomUUID(), membersOnly:true, adminIds:[user!.id], groups:[{id:'-1001', title:'Канал'}]};
    await repo.write(state => {
      state.users.push(user!);
      state.telegramUsers['123456'] = user!.id;
      state.sessions.test = {source:'telegram',userId:user!.id,expiresAt:new Date(Date.now()+60000).toISOString()};
      state.accessSettings.site = policy;
    });
    assert.deepEqual(await reopened.read(state => state.accessSettings.site),policy);
    for (const profile of [false,true]) assert.deepEqual((await reopened.readSession('test',Date.now(),profile))?.policy,policy);
    await repo.write(state => { state.accessSettings.site!.adminIds = []; state.accessSettings.site!.revision = randomUUID(); });
    assert.deepEqual((await reopened.readSession('test',Date.now(),false))?.policy?.adminIds,[]);
    const at = Date.now();
    await Promise.all([repo.touchSessions(new Map([['test',at]]),sessionIdleMs), reopened.touchSessions(new Map([['test',at + 1]]),sessionIdleMs)]);
    const session = (await reopened.userSessions(user!.id,at + 1)).test!;
    assert.ok(session.lastActiveAt);
    assert.ok(Date.parse(session.firstSeenAt!) <= Date.parse(session.lastActiveAt!));
    assert.equal(Date.parse(session.expiresAt),at + 1 + sessionIdleMs);
    assert.equal(session.createdAt,undefined);
    await repo.touchSessions(new Map([['test',at - 2000]]),sessionIdleMs);
    assert.equal((await reopened.readSession('test',at + 2000,false))?.lastActiveAt,session.lastActiveAt);
    assert.deepEqual(await reopened.userSessions('other-user',at),{});
    await repo.write(state => { state.sessions.stale = {...session, expiresAt:new Date(at + 2*sessionIdleMs).toISOString(),
      lastActiveAt:new Date(at - sessionIdleMs).toISOString()}; });
    const live = await Promise.all([reopened.readSession('stale',at-1,false), reopened.readSession('stale',at,false)]);
    assert.ok(live[0]); assert.equal(live[1],undefined);
    assert.equal(await reopened.readSession('stale',at,true),undefined);
    await reopened.touchSessions(new Map([['stale',at]]),sessionIdleMs);
    assert.equal((await reopened.userSessions(user!.id,at)).stale,undefined);
    await repo.write(state => { delete state.sessions.test; });
    await reopened.touchSessions(new Map([['test',at + 300000]]),sessionIdleMs);
    assert.deepEqual(await reopened.userSessions(user!.id,at),{});
  } finally {
    await Promise.all([repo.close(),reopened.close()]);
    await db.query('DROP SCHEMA ' + schema + ' CASCADE');
    await db.end();
  }
});

test('concurrent session reads keep each request time and do not reuse a previous decision', async t => {
  const batches: string[][] = [];
  const live = new Set(['first', 'second']);
  t.mock.method(pg.Pool.prototype, 'query', async (_sql: string, [keys]: [string[]]) => {
    batches.push(keys);
    return { rows: keys.filter(key => live.has(key)).map(id => ({
      id, profile: { id: 'user-' + id }, expires: new Date(1000).toISOString(),
    })) };
  });
  const repo = new PostgresRepository('postgres://localhost/test');
  t.after(() => repo.close());
  const values = await Promise.all([repo.readSession('first', 999, false), repo.readSession('second', 999, false),
    repo.readSession('first', 1000, false), repo.readSession('unknown', 999, false)]);
  assert.deepEqual(values.map(v => v?.user.id), ['user-first', 'user-second', undefined, undefined]);
  live.clear();
  assert.equal(await repo.readSession('first', 999, false), undefined);
  assert.deepEqual(batches, [['first', 'second', 'unknown'], ['first']]);
});

test('the write queue sheds excess requests before checkout and releases capacity on failure', async t => {
  let attempts = 0;
  t.mock.method(pg.Pool.prototype, 'connect', async () => { attempts++; throw new Error('offline'); });
  const repo = new PostgresRepository('postgres://localhost/test');
  t.after(() => repo.close());
  const writes = Array.from({ length: 32 }, () => repo.write(() => assert.fail('unexpected write')));
  await assert.rejects(repo.write(() => assert.fail('unexpected write')), { status: 503, code: 'WRITE_BUSY' });
  await Promise.allSettled(writes);
  assert.equal(attempts, 32);
  await assert.rejects(repo.write(() => undefined), /offline/);
});
