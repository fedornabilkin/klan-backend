import test from 'node:test';
import assert from 'node:assert/strict';
import { createSeed } from './seed.js';
import { MemoryRepository } from './repository.js';
import { editEntity, joinEntity, leaveEntity, querySchema, listResource, publicActivity, setResult, updateProfile, visibleState } from './domain.js';
import { profileEntryText } from './shared/profile-entries.js';

test('one active team invariant applies even for concurrent joins', async () => {
  const state = createSeed(); const user = state.users.at(-1)!;
  const repo = new MemoryRepository(state);
  const results = await Promise.allSettled(['team-1', 'team-2'].map(id => repo.write(draft => joinEntity(draft, 'teams', id, user, {}))));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(await repo.read(draft => draft.entities.filter(e => e.type === 'teams' && e.status === 'active' && e.participants.some(p => p.user.id === user.id)).length), 1);
});
test('archive activation cannot violate active team membership', () => {
  const state = createSeed();
  assert.throws(() => editEntity(state, 'teams', 'team-4', { status: 'active' }, state.users[0]!), { code: 'ACTIVE_TEAM_EXISTS' });
});
test('activity avatars use current callsigns and membership even for old events', () => {
  const state = createSeed();
  const person = state.users[0]!, team = state.entities.find(e => e.id === 'team-1')!;
  person.callsign = 'Сокол';
  const event = {...state.activities[0]!, actor:{...state.activities[0]!.actor,id:person.id}, target:{path:'/users/'+person.id,title:person.name}};
  const first = publicActivity(state,event);
  assert.equal(first.actor.callsign,'Сокол');
  assert.equal(first.target?.user?.hasActiveTeam,true);
  team.status = 'archived';
  assert.equal(publicActivity(state,event).actor.hasActiveTeam,false);
});
test('profile cannot modify role or somebody else', () => {
  const state = createSeed();
  assert.throws(() => updateProfile(state, 'user-2', { bio: 'Hijacked' }, state.users[2]!), { code: 'FORBIDDEN' });
  assert.throws(() => updateProfile(state, 'user-2', { role: 'admin' }, state.users[1]!));
});

test('unknown coordinates stay null while incomplete and out-of-range pairs are rejected', () => {
  const state = createSeed(); const user = state.users[1]!;
  const unknown = { city: '  Москва  ', country: 'Россия', lat: null, lng: null };
  assert.deepEqual(updateProfile(state, user.id, { location: unknown }, user).location,
    { city: 'Москва', country: 'Россия', lat: null, lng: null });
  assert.deepEqual(updateProfile(state, user.id, { location: { city: '', country: '' } }, user).location,
    { city: '', country: '', lat: null, lng: null });
  for (const coordinates of [{ lat: null, lng: 37 }, { lat: 55, lng: null }, { lat: 91, lng: 37 }, { lat: 55, lng: 181 }]) {
    assert.throws(() => updateProfile(state, user.id, { location: { ...unknown, ...coordinates } }, user));
    assert.equal(user.location.lat, null);
    assert.equal(user.location.lng, null);
  }
  assert.deepEqual(updateProfile(state, user.id, { location: { city: '', country: '', lat: 0, lng: 0 } }, user).location,
    { city: '', country: '', lat: 0, lng: 0 });
});

test('long imported facts survive profile saves without truncation while other fields retain their limits', () => {
  const state = createSeed(); const user = state.users[1]!;
  const facts = [281, 272, 282, 1000].map(length => 'Ф'.repeat(length));
  const saved = updateProfile(state, user.id, { bio: 'Обновлённый профиль', facts }, user);
  assert.deepEqual(saved.facts.map(profileEntryText), facts);
  assert.deepEqual(state.users[1]!.facts.map(profileEntryText), facts);
  assert.throws(() => updateProfile(state, user.id, { facts: ['Ф'.repeat(1001)] }, user));
  assert.throws(() => updateProfile(state, user.id, { interests: ['И'.repeat(251)] }, user));
  assert.throws(() => updateProfile(state, user.id, { achievements: ['Д'.repeat(1001)] }, user));
  assert.deepEqual(user.facts.map(profileEntryText), facts);
});
test('feedback owner may edit text but cannot change workflow status', () => {
  const state = createSeed();
  assert.equal(editEntity(state, 'feedback', 'feedback-1', { description: 'Уточнение' }, state.users[3]!).description, 'Уточнение');
  assert.equal(state.entities.find(entity => entity.id === 'feedback-1')!.status, 'in_progress');
  assert.throws(() => editEntity(state, 'feedback', 'feedback-1', { status: 'resolved' }, state.users[3]!), { code: 'FORBIDDEN' });
  assert.throws(() => editEntity(state, 'feedback', 'feedback-1', { description: 'Чужое' }, state.users[2]!), { code: 'FORBIDDEN' });
});
test('result cannot be recorded before exact start time even on same calendar date', () => {
  const now = new Date('2026-11-11T09:00:00Z'); const state = createSeed(now);
  const entity = state.entities.find(item => item.id === 'challenge-1')!;
  entity.schedule!.start = '2026-11-11T12:00:00Z';
  assert.throws(() => setResult(state, entity.id, state.users[0]!, { date: '2026-11-11', value: 10 }, now), { code: 'CHALLENGE_NOT_STARTED' });
});
test('existing results lock challenge metric and incompatible attendance conversion', () => {
  const state = createSeed();
  assert.throws(() => editEntity(state, 'challenges', 'challenge-1', { category: 'attendance' }, state.users[0]!), { code: 'CHALLENGE_METRIC_LOCKED' });
  assert.throws(() => editEntity(state, 'challenges', 'challenge-1', { goal: { target: 100, unit: 'км' } }, state.users[0]!), { code: 'CHALLENGE_METRIC_LOCKED' });
});
test('member views omit drafts and their activity targets', () => {
  const state = createSeed(); const entity = state.entities.find(item => item.id === 'event-1')!;
  entity.status = 'draft';
  const view = visibleState(state, state.users[1]!);
  assert.ok(!view.entities.some(item => item.id === entity.id));
  assert.ok(!view.activities.some(item => item.target?.path === '/events/event-1'));
  assert.ok(visibleState(state, state.users[0]!).entities.some(item => item.id === entity.id));
  assert.equal(listResource(view, 'events', querySchema.parse({})).meta.total, 5);
});

test('leaving a draft cannot reveal it to a member or change participation', () => {
  for (const resource of ['events', 'challenges'] as const) {
    const state = createSeed();
    const entity = state.entities.find(item => item.type === resource)!;
    entity.status = 'draft';
    const member = state.users[1]!;
    entity.participants = [{ user: member }];
    entity.results = [];
    const before = structuredClone(entity);
    assert.throws(() => leaveEntity(state, resource, entity.id, member), { code: 'NOT_FOUND' });
    assert.throws(() => leaveEntity(state, resource, entity.id, state.users.at(-1)!), { code: 'NOT_FOUND' });
    assert.deepEqual(entity, before);
    assert.equal(leaveEntity(state, resource, entity.id, state.users[0]!).id, entity.id);
  }
});
test('result is upserted by user/date, future date denied, finished challenge locked', () => {
  const now = new Date('2026-11-11T12:00:00Z'); const state = createSeed(now); const user = state.users[0]!;
  setResult(state, 'challenge-1', user, { date: '2026-11-11', value: 100 }, now);
  setResult(state, 'challenge-1', user, { date: '2026-11-11', value: 120 }, now);
  const entity = state.entities.find(e => e.id === 'challenge-1')!;
  assert.equal(entity.results!.filter(r => r.user.id === user.id && r.date === '2026-11-11').length, 1);
  assert.equal(entity.results!.find(r => r.user.id === user.id && r.date === '2026-11-11')!.value, 120);
  assert.throws(() => setResult(state, entity.id, user, { date: '2026-11-12', value: 20 }, now), { code: 'INVALID_RESULT_DATE' });
  assert.throws(() => setResult(state, entity.id, user, { date: '2026-11-11', value: 20 }, new Date('2026-12-15')), { code: 'CHALLENGE_FINISHED' });
  assert.throws(() => leaveEntity(state, 'challenges', entity.id, user), { code: 'RESULTS_EXIST' });
});
test('team challenge join requires active team membership and snapshots scoring team', () => {
  const state = createSeed(); const user = state.users[20]!;
  assert.throws(() => joinEntity(state, 'challenges', 'challenge-1', user, { teamId: 'team-1' }), { code: 'FORBIDDEN' });
  joinEntity(state, 'teams', 'team-1', user, {});
  const entity = joinEntity(state, 'challenges', 'challenge-1', user, { teamId: 'team-1' });
  assert.equal(entity.participants.find(p => p.user.id === user.id)?.team?.id, 'team-1');
});
test('counting challenges accept whole goals and results, while distances accept decimals', () => {
  const now = new Date('2026-11-11T12:00:00Z'), date = '2026-11-11';
  const state = createSeed(now), admin = state.users[0]!;
  const challenge = state.entities.find(e => e.id === 'challenge-1')!;
  assert.throws(() => setResult(state, challenge.id, admin, {date,value:2.5}, now), {code:'INVALID_CHALLENGE_RESULT'});
  assert.throws(() => editEntity(state,'challenges',challenge.id,{goal:{target:3.5,unit:challenge.goal!.unit}},admin), {code:'INVALID_CHALLENGE_GOAL'});
  challenge.goal!.target = 3.5;
  assert.equal(editEntity(state,'challenges',challenge.id,{title:'Другое название'},admin).goal!.target,3.5);
  challenge.category = 'distance';
  const saved = setResult(state, challenge.id, admin, {date,value:2.5}, now);
  assert.ok(saved.results?.some(r => r.user.id === admin.id && r.date === date && r.value === 2.5));
});
test('search covers facts and tags; pagination contains stable total', () => {
  const state = createSeed();
  const response = listResource(state, 'users', querySchema.parse({ q: 'самостоятельных', limit: '5', page: '2', sort: 'name' }));
  assert.equal(response.meta.total, 24); assert.equal(response.data.length, 5); assert.equal(response.meta.pages, 5);
  assert.throws(() => querySchema.parse({ limit: '10000' }));
});
test('failed unit of work rolls back all changes', async () => {
  const repo = new MemoryRepository(createSeed());
  await assert.rejects(repo.write(state => { state.users.length = 0; throw new Error('rollback'); }));
  assert.equal(await repo.read(state => state.users.length), 24);
});
test('attendance only accepts 0 or 1 and non-participants cannot score', () => {
  const state = createSeed(); const today = new Date().toISOString().slice(0, 10);
  assert.throws(() => setResult(state, 'challenge-3', state.users[2]!, { date: today, value: 5 }), { code: 'INVALID_ATTENDANCE' });
  assert.throws(() => setResult(state, 'challenge-3', state.users[23]!, { date: today, value: 1 }), { code: 'JOIN_REQUIRED' });
});
