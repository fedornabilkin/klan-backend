import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { PostgresRepository } from './repository.js';

test('PostgresRepository survives an idle connection error and replaces the failed client', async t => {
  // Exercise the real pg.Pool lifecycle without opening a socket or touching a database.
  t.mock.method(pg.Client.prototype, 'connect', function (callback: (error?: Error) => void) {
    queueMicrotask(() => callback());
  });
  t.mock.method(pg.Client.prototype, 'query', function (_text: string, _values: unknown, callback: (error: null, result: object) => void) {
    queueMicrotask(() => callback(null, { rows: [{ '?column?': 1 }], rowCount: 1 }));
  });
  t.mock.method(pg.Client.prototype, 'end', function (this: pg.Client, callback?: () => void) {
    this.emit('end');
    callback?.();
  });
  const logged = t.mock.method(console, 'error', () => undefined);
  const repo = new PostgresRepository('postgres://test:private-password@127.0.0.1/test');
  t.after(() => repo.close());
  const pool = (repo as unknown as { pool: pg.Pool }).pool;
  const clients: pg.PoolClient[] = [];
  pool.on('connect', client => clients.push(client));

  await repo.ping();
  assert.equal(pool.idleCount, 1);
  assert.equal(clients.length, 1);
  const failure = Object.assign(new Error('private connection details must not be logged'), { code: 'ECONNRESET' });
  assert.doesNotThrow(() => clients[0]!.emit('error', failure));
  assert.equal(pool.totalCount, 0);
  assert.equal(logged.mock.callCount(), 1);
  const log = JSON.stringify(logged.mock.calls[0]!.arguments);
  assert.match(log, /ECONNRESET/);
  assert.doesNotMatch(log, /private-password|private connection details|connectionParameters|postgres:\/\//);

  await repo.ping();
  assert.equal(clients.length, 2);
  assert.notEqual(clients[0], clients[1]);
  assert.equal(pool.idleCount, 1);
});

test('PostgresRepository keeps malformed error details out of the log', async t => {
  const logged = t.mock.method(console, 'error', () => undefined);
  const repo = new PostgresRepository('postgres://test:private-password@127.0.0.1/test');
  t.after(() => repo.close());
  const pool = (repo as unknown as { pool: pg.Pool }).pool;
  const failure = Object.assign(new Error('private message'), { code: 'private-password\nsecond line', client: { password: 'private-password' } });

  assert.doesNotThrow(() => pool.emit('error', failure));
  assert.equal(logged.mock.callCount(), 1);
  assert.match(String(logged.mock.calls[0]!.arguments[0]), /UNKNOWN/);
  assert.doesNotMatch(JSON.stringify(logged.mock.calls[0]!.arguments), /private|second line/);
});
