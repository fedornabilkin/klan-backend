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
