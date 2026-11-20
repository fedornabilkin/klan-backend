import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryRepository, emptyState } from '../../src/repository.js';
import { createSeed } from '../../src/seed.js';
import { importReviewedMembers } from './reviewed-members.js';

const member = { sourceId: '49', nodeUid: '1296401f-7055-4f9f-b670-7aebdce01d2b', firstName: 'Инна', lastName: 'Тестова', callsign: 'Ветер' };
const correction = { id: 'historical-test', publicId: 12, firstName: 'Марк', oldLastName: 'Проверов', newLastName: 'Проверков' };
const plan = { version: 1, sourceHash: 'a'.repeat(64), members: [member], correction };
function fixture() {
  const state = emptyState();
  state.userPublicIds.highWater = 80;
  state.users.push({ ...createSeed().users[0]!, id: correction.id, publicId: 12,
    name: 'Марк Проверов', firstName: undefined, middleName: undefined, lastName: undefined, username: 'synthetic_member' });
  state.telegramUsers['900000000'] = correction.id;
  return state;
}
test('review and retries preserve names, callsigns, user data and Telegram bindings', async () => {
  const initial = fixture();
  const repo = new MemoryRepository(initial);
  const preview = await importReviewedMembers(repo, plan);
  assert.deepEqual(preview.added, [{ name: 'Инна Тестова', callsign: 'Ветер' }]);
  assert.equal(preview.rename, true);
  assert.deepEqual(await repo.read(s => s.users), initial.users);
  const [first, retry] = await Promise.all([importReviewedMembers(repo, plan, true), importReviewedMembers(repo, plan, true)]);
  assert.equal(first.added.length, 1);
  assert.deepEqual(retry.known, ['Инна Тестова']);
  assert.equal(retry.rename, false);
  const saved = await repo.read(s => s);
  assert.deepEqual(saved.telegramUsers, initial.telegramUsers);
  assert.deepEqual(saved.users[0], { ...initial.users[0], name: 'Марк Проверков', firstName: 'Марк', lastName: 'Проверков' });
  assert.equal(saved.users[1]!.publicId, 81);
  assert.equal(saved.users[1]!.name, 'Инна Тестова');
  assert.equal(saved.users[1]!.callsign, 'Ветер');
  assert.equal(saved.users[1]!.role, 'member');
  assert.equal(saved.users[1]!.username, undefined);
  await repo.write(s => { s.users[1]!.callsign = 'Новый'; });
  await importReviewedMembers(repo, plan, true);
  await assert.rejects(importReviewedMembers(repo, { ...plan, sourceHash: 'b'.repeat(64) }, true), /Конфликт/);
  assert.equal(await repo.read(s => s.users[1]!.callsign), 'Новый');
});

test('only the confirmed profile is corrected, name collisions are reported without merging', async () => {
  const repo = new MemoryRepository(fixture());
  const single = await importReviewedMembers(repo, plan, true, true);
  assert.equal(single.added.length, 0);
  assert.equal(await repo.read(s => s.users.length), 1);
  await repo.write(s => { s.users.push({ ...s.users[0]!, id: 'separate', publicId: 21, name: 'Тестова Инна', firstName: undefined, lastName: undefined, callsign: 'Север' }); });
  const result = await importReviewedMembers(repo, plan, true);
  assert.deepEqual(result.review, [{ name: 'Инна Тестова', profileIds: [21] }]);
  assert.equal(await repo.read(s => s.users[1]!.callsign), 'Север');
});

test('unexpected identity, conflicting stable ID and duplicate input roll back the batch', async () => {
  const repo = new MemoryRepository(fixture());
  for (const bad of [
    { ...plan, correction: { ...correction, id: 'other' } },
    { ...plan, correction: { ...correction, oldLastName: 'Другая' } },
    { ...plan, members: [member, member] }, { ...plan, members: [{ ...member, role: 'admin' }] },
  ]) await assert.rejects(importReviewedMembers(repo, bad, true));
  await repo.write(s => { s.users.push({ ...s.users[0]!, id: 'member-' + member.nodeUid, publicId: 19 }); });
  await assert.rejects(importReviewedMembers(repo, plan, true), /Конфликт/);
  assert.equal(await repo.read(s => s.users[0]!.name), 'Марк Проверов');
});
