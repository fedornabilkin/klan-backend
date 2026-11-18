import assert from 'node:assert/strict';
import test from 'node:test';
import { allocateUserPublicId } from './user-ids.js';
import { emptyState, MemoryRepository } from './repository.js';
import { createSeed } from './seed.js';
import { userPath } from './shared/user-links.js';

test('Public profile links use positive numeric IDs and preserve legacy internal links', () => {
  assert.equal(userPath({ id: 'internal-uuid', publicId: 1 }), '/users/1');
  assert.equal(userPath({ id: 'old/id ?' }), '/users/old%2Fid%20%3F');
  assert.equal(userPath({ id: 'legacy', publicId: NaN }), '/users/legacy');
});

test('Public IDs are monotonic across deletion and bootstrap from legacy assigned IDs', async () => {
  const state = createSeed();
  state.users[0]!.publicId = 144;
  const repo = new MemoryRepository(state);
  const first = await repo.write(value => allocateUserPublicId(value));
  assert.equal(first, 145);
  await repo.write(value => { value.users = []; });
  assert.equal(await repo.write(value => allocateUserPublicId(value)), 146);
  const restored = new MemoryRepository(await repo.read(value => value));
  assert.equal(await restored.write(value => allocateUserPublicId(value)), 147);
});

test('Allocation rolls back with its unit of work and rejects invalid counters', async () => {
  const repo = new MemoryRepository(emptyState());
  await assert.rejects(repo.write(state => { allocateUserPublicId(state); throw new Error('rollback'); }));
  assert.equal(await repo.write(state => allocateUserPublicId(state)), 1);
  const state = emptyState();
  state.userPublicIds.highWater = Number.MAX_SAFE_INTEGER;
  assert.throws(() => allocateUserPublicId(state), /exhausted/);
});
