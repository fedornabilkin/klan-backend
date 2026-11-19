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
  assert.equal(first, 144 + state.users.length);
  await repo.write(value => { value.users = []; });
  assert.equal(await repo.write(value => allocateUserPublicId(value)), first + 1);
  const restored = new MemoryRepository(await repo.read(value => value));
  assert.equal(await restored.write(value => allocateUserPublicId(value)), first + 2);
});

test('Allocation rolls back with its unit of work and rejects invalid counters', async () => {
  const repo = new MemoryRepository(emptyState());
  await assert.rejects(repo.write(state => { allocateUserPublicId(state); throw new Error('rollback'); }));
  assert.equal(await repo.write(state => allocateUserPublicId(state)), 1);
  const state = emptyState();
  state.userPublicIds.highWater = Number.MAX_SAFE_INTEGER;
  assert.throws(() => allocateUserPublicId(state), /exhausted/);
});

test('Legacy entity URLs keep their number across renames and never reuse a deleted number',async () => {
  const repo = new MemoryRepository(createSeed());
  const initial = await repo.read(s => s.entities.map(e => ({id:e.id, num:e.publicId!})));
  assert.equal(new Set(initial.map(e => e.num)).size, initial.length);
  const last = initial.reduce((a,b) => a.num>b.num ? a : b);
  await repo.write(s => { s.entities = s.entities.filter(e => e.id !== last.id); s.entities[0]!.title='Renamed'; });
  await repo.write(s => { s.entities.push({...s.entities[0]!,id:'legacy-import-new',publicId:undefined}); });
  const state = await repo.read(s => s);
  assert.equal(state.entities.at(-1)!.publicId,last.num+1);
  assert.equal(state.entities[0]!.publicId,initial.find(e => e.id===state.entities[0]!.id)!.num);
});
