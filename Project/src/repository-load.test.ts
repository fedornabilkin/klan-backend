import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';
import { PostgresRepository } from './repository.js';

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
