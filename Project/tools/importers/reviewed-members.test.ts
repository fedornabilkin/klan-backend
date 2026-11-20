import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryRepository, emptyState } from '../../src/repository.js';
import { createSeed } from '../../src/seed.js';
import { importReviewedMembers } from './reviewed-members.js';
import type { Entity } from '../../src/shared/contracts.js';

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

const numberedPlan = { ...plan, profileNumbers: { firstId: 'member-' + member.nodeUid, secondId: 'stay-with-account', formerSecondId: 'displaced' } };
function numberedFixture() {
  const state = fixture();
  const [one, two] = [1, 2].map(publicId => ({
    ...state.users[0]!, id: publicId === 1 ? 'stay-with-account' : 'displaced',
    publicId, name: publicId === 1 ? 'Никита Первый' : 'Рита Вторая',
  }));
  state.users.push(one!, two!);
  state.telegramUsers['800000000'] = one!.id;
  state.sessions.existing = { userId: two!.id, expiresAt: '2099-01-01' };
  const entity = { id: 'challenge', type: 'challenges', publicId: 1, author: structuredClone(one),
    participants: [{ user: structuredClone(two), team: { id: 'team', title: 'Команда', publicId: 2 } }],
    results: [{ user: structuredClone(one), value: 70, date: '2026-10-01' }], pendingResults: [{ user: structuredClone(two), value: 4 }],
    readers: [structuredClone(one)], organizer: { userId: one!.id }, organizerUser: structuredClone(one),
    historicalImport: { report: { decisions: [{ userId: two!.id, publicId: 2, teamId: 'team' }] } },
  };
  state.entities.push(entity as unknown as Entity);
  const target = (path: string, id: string) => ({ id, actor: structuredClone(one!), action: 'edited', createdAt: '2026-01-02', target: { title: '', path } });
  state.activities.push(target('/users/1', 'numeric'), target('/users/2/?q=1#bio','suffix'), target('/teams/2','team'), target('/users/displaced','stable'));
  state.activities[0]!.target!.user = structuredClone(one!);
  return state;
}

test('renumbers confirmed accounts and every stored profile reference exactly once', async () => {
  const original = numberedFixture();
  const repo = new MemoryRepository(original);
  const preview = await importReviewedMembers(repo, numberedPlan);
  assert.deepEqual(preview.numbers!.profiles.map(p => [p.from, p.to]), [[null,1],[1,2],[2,81]]);
  assert.equal(preview.numbers!.links, 2);
  assert.deepEqual(await repo.read(s => s.users), original.users);
  const first = await importReviewedMembers(repo, numberedPlan, true);
  assert.deepEqual(first.numbers, preview.numbers);
  const after = await repo.read(s => s);
  assert.deepEqual(after.users.slice(0,3).map(u => [u.id,u.publicId]), [['displaced',81],['stay-with-account',2],[numberedPlan.profileNumbers.firstId,1]]);
  assert.deepEqual(after.sessions, original.sessions);
  assert.deepEqual(after.telegramUsers, original.telegramUsers);
  assert.equal(after.userPublicIds.highWater,81);
  const event = after.entities[0]!;
  assert.equal(event.publicId,1); assert.equal(event.participants[0]!.team!.publicId,2);
  assert.deepEqual([event.author, event.organizerUser, event.readers![0], event.results![0]!.user].map(u => u!.publicId),[2,2,2,2]);
  assert.deepEqual([event.participants[0]!.user.publicId,event.pendingResults![0]!.user.publicId],[81,81]);
  assert.equal(event.results![0]!.value,70);
  assert.deepEqual(event.organizer, {userId:'stay-with-account'});
  assert.equal((event as unknown as {historicalImport:{report:{decisions:{publicId:number}[]}}}).historicalImport.report.decisions[0]!.publicId,81);
  assert.deepEqual(after.activities.map(a => a.target!.path),['/users/2','/users/81/?q=1#bio','/teams/2','/users/displaced']);
  assert.equal(after.activities[0]!.target!.user!.publicId,2);
  assert.ok(after.activities.every(a => a.actor.publicId === 2));
  const retry = await importReviewedMembers(repo,numberedPlan,true);
  assert.equal(retry.numbers!.links,0); assert.equal(retry.numbers!.snapshots,0);
  assert.deepEqual(await repo.read(s=>s),after);
});

test('an already imported member moves from their previous number; unexpected ownership rolls back', async () => {
  const repo = new MemoryRepository(numberedFixture());
  await importReviewedMembers(repo, plan, true);
  await repo.write(s => { s.activities.push({ ...s.activities[0]!, id:'previous-link', target:{title:'',path:'/users/81'} }); });
  const result = await importReviewedMembers(repo, numberedPlan,true);
  assert.deepEqual(result.numbers!.profiles.map(p => [p.from,p.to]), [[81,1],[1,2],[2,82]]);
  assert.equal(await repo.read(s=>s.activities.at(-1)!.target!.path),'/users/1');
  const conflict = numberedFixture();
  conflict.users.find(u=>u.publicId===2)!.id='unexpected-owner';
  const unsafe = new MemoryRepository(conflict);
  const before = await unsafe.read(s=>s);
  await assert.rejects(importReviewedMembers(unsafe, numberedPlan,true));
  assert.deepEqual(await unsafe.read(s=>s),before);
});
