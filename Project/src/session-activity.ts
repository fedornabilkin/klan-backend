import type { Repository } from './repository.js';
import { activityInterval, renewSession } from './sessions.js';

/** Keep the last real browser request, including the final request between two database writes. */
export function sessionActivity(repo: Repository, ttl: number, now: () => number) {
  const interval = Math.min(activityInterval, Math.max(1, Math.floor(ttl / 2)));
  let pending = new Map<string, number>();
  let timer: NodeJS.Timeout | undefined;
  let due = Infinity;
  let writing = Promise.resolve();

  function remember(key: string, at: number) {
    pending.set(key, Math.max(at, pending.get(key) ?? at));
    if (timer) return;
    due = now() + interval;
    timer = setTimeout(() => {
      void flush().catch(() => console.warn('Session activity write will be retried.'));
    }, interval);
    timer.unref();
  }

  function persist(batch: ReadonlyMap<string, number>): Promise<void> {
    const operation = writing.then(async () => {
      if (repo.touchSessions) await repo.touchSessions(batch, ttl);
      else await repo.write(state => {
        for (const [key, at] of batch) {
          const session = state.sessions[key];
          if (session) renewSession(session, at, ttl);
        }
      });
    });
    writing = operation.catch(() => {
      for (const [key, at] of batch) if (at + ttl > now()) remember(key, at);
    });
    return operation;
  }

  function flush(): Promise<void> {
    clearTimeout(timer);
    timer = undefined;
    due = Infinity;
    const batch = pending;
    pending = new Map();
    return batch.size ? persist(batch) : writing;
  }

  return {
    flush,
    flushDue: () => now() >= due ? flush() : writing,
    record(key: string, at: number, lastActiveAt: string | undefined, expiresAt: number) {
      const recorded = Date.parse(lastActiveAt ?? '');
      // Renew synchronously on return from an absence, or before a legacy fixed deadline.
      if (!Number.isFinite(recorded) || recorded <= at - interval || expiresAt <= at + interval) {
        const latest = Math.max(at, pending.get(key) ?? at);
        pending.delete(key);
        return persist(new Map([[key, latest]]));
      }
      if (recorded < at) remember(key, at);
    },
  };
}
