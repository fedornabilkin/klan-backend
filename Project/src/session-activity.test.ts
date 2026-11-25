import assert from 'node:assert/strict';
import test from 'node:test';
import { MemoryRepository } from './repository.js';
import { sessionActivity } from './session-activity.js';
import { activityInterval, sessionIdleMs } from './sessions.js';

test('batched renewal retries the most recent real activity, without extending idle time to the time of the write', async () => {
  const start = Date.UTC(2026,10,25);
  const expiry = start + sessionIdleMs;
  let now = start;
  let fail = true;
  const written: Map<string,number>[] = [];
  class BatchRepository extends MemoryRepository {
    async touchSessions(values: ReadonlyMap<string,number>) {
      if (fail) throw new Error('temporarily offline');
      written.push(new Map(values));
    }
  }
  const activity = sessionActivity(new BatchRepository(), sessionIdleMs, () => now);
  const seen = new Date(start).toISOString();
  await activity.record('first',start+1,seen,expiry);
  await activity.record('second',start+2,seen,expiry);
  await activity.record('first',start+3,seen,expiry);
  now += activityInterval;
  await assert.rejects(activity.flushDue(),/temporarily offline/);
  await activity.record('second',now+1,new Date(now).toISOString(),expiry);
  fail = false;
  await activity.flush();
  assert.deepEqual(written,[new Map([['first',start+3],['second',now+1]])]);
});
