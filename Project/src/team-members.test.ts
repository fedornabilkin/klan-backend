import test from 'node:test';
import assert from 'node:assert/strict';
import { accessForLevel } from './access.js';
import { MemoryRepository } from './repository.js';
import { createSeed } from './seed.js';
import { excludeTeamMember, setTeamRole } from './team-members.js';
import { teamChallengeSummaries } from './resource-reads.js';

test('team roles belong to the roster and concurrent assignments leave one captain and multiple deputies', async () => {
  const seed = createSeed(), admin = seed.users[0]!, repo = new MemoryRepository(seed);
  const team = seed.entities.find(e => e.id === 'team-1')!;
  const [first, second, third, fourth] = team.participants.map(p => p.user.id) as [string,string,string,string];
  const role = (user: string, role: string) => repo.write(s => setTeamRole(s, team.id, user, { role }, admin));
  await Promise.all([role(first, 'captain'), role(second, 'captain'), role(third, 'deputy'), role(fourth, 'deputy')]);
  await assert.rejects(role('absent', 'captain'), { status: 404 });
  await assert.rejects(role(first, 'owner'));
  for (const level of ['member','moderator'] as const) {
    const actor = { ...admin, access: accessForLevel(level, 'demo') };
    assert.throws(() => setTeamRole(seed, team.id, first, {role:'captain'}, actor), {status:403});
    assert.throws(() => excludeTeamMember(seed, team.id, first, {comment:'Причина'}, actor), {status:403});
  }
  const roster = await repo.read(s => s.entities.find(e => e.id === team.id)!.participants);
  assert.deepEqual(roster.filter(p => p.teamRole === 'captain').map(p => p.user.id), [second]);
  assert.deepEqual(roster.filter(p => p.teamRole === 'deputy').map(p => p.user.id), [third, fourth]);
  // The relation needs only the stored profile ID, even if its snapshot has no public number.
  await repo.write(s => {
    const profile = s.users.find(u => u.id === second)!;
    const member = s.entities.find(e => e.id === team.id)!.participants.find(p => p.user.id === second)!;
    member.user = {...member.user, publicId:undefined};
    setTeamRole(s, team.id, String(profile.publicId), {role:'member'}, admin);
  });
  assert.ok(await repo.read(s => !s.entities.find(e => e.id === team.id)!.participants.some(p => p.teamRole === 'captain')));
});

test('removal requires a comment, records the administrator and preserves historical scores and targets', () => {
  const state = createSeed(), admin = state.users[0]!, member = state.users[1]!;
  const team = state.entities.find(e => e.id === 'team-1')!;
  const challenge = state.entities.find(e => e.id === 'challenge-1')!;
  challenge.status = 'completed';
  challenge.goal = {target:1000,unit:'раз',scope:'participant'};
  const ref = { id: team.id, title: team.title };
  challenge.participants = [{user:admin,team:ref},{user:member,team:ref},{user:member,team:ref}];
  challenge.participants.push({user:member,team:{id:'team-2',title:'Другая команда'}});
  assert.equal(teamChallengeSummaries([challenge], 'team-2').teamChallenges.filter(h => h.target).length, 0);
  challenge.results = [{user:member,team:ref,value:17,date:'2020-02-01'}, {user:admin,value:8,date:'2020-02-01'}];
  challenge.pendingResults = [{user:member,team:ref,value:100,reason:'Нет даты',sourceCell:'А1'}];
  const history = () => teamChallengeSummaries(state.entities,team.id).teamChallenges;
  assert.deepEqual(history().map(h => [h.score,h.target,h.unit,h.members,h.personalTarget]), [[17,2000,'раз',2,1000]]);
  setTeamRole(state,team.id,member.id,{role:'captain'},admin);
  assert.throws(() => excludeTeamMember(state,team.id,member.id,{comment:'  '},admin));
  assert.equal(state.teamExclusions.length, 0);
  excludeTeamMember(state,team.id,member.id,{comment:'  По просьбе участника  '},admin);
  assert.ok(!team.participants.some(p => p.user.id === member.id));
  const audit = state.teamExclusions[0]!;
  assert.deepEqual([audit.teamId,audit.userId,audit.adminId,audit.comment], [team.id,member.id,admin.id,'По просьбе участника']);
  assert.deepEqual(history().map(h => [h.score,h.target]), [[17,2000]]);
  assert.throws(() => excludeTeamMember(state,team.id,member.id,{comment:'Повтор'},admin), {status:404});
  assert.equal(state.teamExclusions.length,1);
  challenge.status = 'draft'; assert.equal(history().length,0);
  challenge.status = 'active'; assert.equal(history().length,0);
  const current = () => teamChallengeSummaries([challenge],team.id).activeTeamChallenges;
  assert.deepEqual(current().map(h => [h.score,h.members,h.personalTarget,h.target]), [[17,2,1000,2000]]);
  challenge.schedule = {start:'2099-01-01',end:'2099-02-01'}; assert.equal(current().length,0);
  challenge.schedule = {start:'2011-12-01',end:'2012-01-01'}; challenge.results = []; assert.equal(history()[0]!.score,0);
});
