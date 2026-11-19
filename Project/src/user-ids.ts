import type { DatabaseState } from './repository.js';

/** Call inside repo.write. The persisted high-water mark prevents recycling deleted profile URLs. */
export function allocateUserPublicId(state: DatabaseState): number {
  state.userPublicIds ??= {};
  const highWater = state.userPublicIds.highWater ?? 0;
  if (!Number.isSafeInteger(highWater) || highWater < 0) throw new Error('Invalid user public ID high-water mark');
  const existingMaximum = state.users.reduce((maximum, user) =>
    typeof user.publicId === 'number' && Number.isSafeInteger(user.publicId) && user.publicId > maximum ? user.publicId : maximum, 0);
  const next = Math.max(highWater, existingMaximum) + 1;
  if (!Number.isSafeInteger(next)) throw new Error('User public IDs exhausted');
  state.userPublicIds.highWater = next;
  return next;
}

/** Reserve existing public IDs before numbering imported or legacy rows. */
function numberRecords(rows: {id:string; publicId?:number}[], high: number) {
  if (!Number.isSafeInteger(high) || high < 0) throw new Error('Invalid public ID counter');
  const reserved = new Set<number>();
  for (const row of rows) {
    const numeric = Number(row.id);
    if (Number.isSafeInteger(numeric) && numeric > 0 && String(numeric) === row.id) {
      row.publicId ??= numeric;
      high = Math.max(high,numeric);
    }
    if (row.publicId === undefined) continue;
    if (!Number.isSafeInteger(row.publicId) || row.publicId < 1 || reserved.has(row.publicId)) throw new Error('Invalid public ID');
    reserved.add(row.publicId);
    high = Math.max(high, row.publicId);
  }
  for (const row of rows.filter(row => row.publicId === undefined).sort((a,b) => a.id < b.id ? -1 : 1)) {
    if (!Number.isSafeInteger(high + 1)) throw new Error('Public IDs exhausted');
    row.publicId = ++high;
  }
  return high;
}

export function assignPublicIds(state: DatabaseState) {
  const user = numberRecords(state.users,state.userPublicIds.highWater ?? 0);
  const entity = numberRecords(state.entities,state.userPublicIds.entityHighWater ?? 0);
  if (user) state.userPublicIds.highWater = user;
  if (entity) state.userPublicIds.entityHighWater = entity;
}
