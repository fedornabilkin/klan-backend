import assert from 'node:assert/strict';
import test from 'node:test';
import type { Entity, User } from './shared/contracts.js';
import { communityAnalytics, memberAnalytics, membersAnalytics, parseAnalyticsRange } from './analytics.js';
import { createEntity, editEntity, hydrateEntity, hydrateUser, joinEntity, leaveEntity, setResult } from './domain.js';
import { emptyState } from './repository.js';

function fixture() {
  const state = emptyState();
  const user: User = {
    id: 'participant', name: 'Участник', username: 'participant', role: 'admin',
    bio: '', location: { city: '', country: '', lat: null, lng: null },
    tags: [], initials: 'У', color: '#abc', facts: [], interests: [], achievements: [],
    stats: { events: 0, challenges: 0, books: 0 }, joinedAt: '2025-01-01T00:00:00Z',
  };
  const team: Entity = {
    id: 'team', type: 'teams', title: 'Команда', description: '', status: 'active',
    category: '', tags: [], createdAt: '2026-10-01T00:00:00Z', participants: [{ user }],
  };
  const teamSnapshot = { id: team.id, title: team.title };
  const challenge: Entity = {
    id: 'challenge', type: 'challenges', title: 'Октябрь', description: '', status: 'completed',
    category: 'count', tags: [], createdAt: '2026-11-13T00:00:00Z',
    schedule: { start: '2026-10-01T00:00:00+03:00', end: '2026-10-31T23:59:59+03:00' },
    goal: { target: 1000, unit: 'повторений' },
    participants: [{ user, team: teamSnapshot, target: 200 }],
    results: [{ user, date: '2026-10-02', value: 10, team: teamSnapshot }],
  };
  state.users = [user]; state.entities = [team, challenge];
  return { state, user, team, challenge, teamSnapshot };
}

test('undated imported values never enter dated totals, community/member analytics or profile stats', () => {
  const { state, user, challenge, teamSnapshot } = fixture();
  const range = parseAnalyticsRange({ from: '2026-10-01', to: '2026-10-31' }, new Date('2026-11-13'));
  const before = {
    community: communityAnalytics(state, range), member: memberAnalytics(state, user.id, range, {}),
    members: membersAnalytics(state, range, {}), stats: hydrateUser(state, user).stats,
  };
  challenge.pendingResults = [
    { user, value: 900, team: teamSnapshot, sourceCell: 'Лист1!AO9', reason: 'Дата не подтверждена' },
    { user, value: 0, team: teamSnapshot, sourceCell: 'Лист1!AP9', reason: 'Дата не подтверждена' },
  ];
  assert.deepEqual(communityAnalytics(state, range), before.community);
  assert.deepEqual(memberAnalytics(state, user.id, range, {}), before.member);
  assert.deepEqual(membersAnalytics(state, range, {}), before.members);
  assert.deepEqual(hydrateUser(state, user).stats, before.stats);
  const dto = hydrateEntity(state, challenge);
  assert.equal(dto.results?.reduce((sum, result) => sum + result.value, 0), 10);
  assert.equal(dto.pendingResults?.reduce((sum, result) => sum + result.value, 0), 900);
  assert.ok(dto.pendingResults?.every(result => !('date' in result)));
});

test('entity hydration updates every result user once per ID and omits private import provenance', () => {
  const { state, user, challenge, teamSnapshot } = fixture();
  const stale = { ...user, name: 'Старое имя', username: 'old_name' };
  Object.assign(user, { name: 'Новое имя', historicalImport: { privateSource: 'profile' }, communityImport: { telegramId: '12345' } });
  Object.assign(challenge, { historicalImport: { file: '/private/source.xlsx' } });
  challenge.participants = [{ user: stale, target: 200, team: teamSnapshot }];
  challenge.author = stale;
  challenge.results = Array.from({ length: 31 }, (_, index) => ({ user: stale, date: `2026-10-${String(index + 1).padStart(2, '0')}`, value: index, team: teamSnapshot }));
  challenge.pendingResults = [{ user: stale, value: 50, team: teamSnapshot, sourceCell: 'AO9', reason: 'Проверка даты' }];
  const before = structuredClone(state);
  const dto = hydrateEntity(state, challenge);
  const hydrated = dto.participants[0]!.user;
  assert.equal(hydrated.name, 'Новое имя');
  assert.equal(hydrated.username, 'participant');
  assert.equal(dto.participants[0]!.target, 200);
  assert.equal(dto.pendingResults![0]!.sourceCell, 'AO9');
  assert.strictEqual(dto.author, hydrated);
  assert.ok(dto.results?.every(result => result.user === hydrated));
  assert.strictEqual(dto.pendingResults![0]!.user, hydrated);
  assert.ok(!('historicalImport' in dto));
  assert.ok(!('historicalImport' in hydrated));
  assert.ok(!('communityImport' in hydrated));
  assert.equal(JSON.stringify(dto).includes('privateSource'), false);
  assert.deepEqual(state, before);
});

test('ordinary entity and participation APIs cannot inject pending results or imported targets', () => {
  const { state, user, challenge, teamSnapshot } = fixture();
  const pending = { user, value: 50, team: teamSnapshot, sourceCell: 'AO9', reason: 'Проверка даты' };
  const before = structuredClone(state);
  const input = { title: 'Новый', description: '', schedule: challenge.schedule, goal: challenge.goal, pendingResults: [pending] };
  assert.throws(() => createEntity(state, 'challenges', input, user));
  assert.throws(() => editEntity(state, 'challenges', challenge.id, { pendingResults: [pending] }, user));
  assert.throws(() => editEntity(state, 'challenges', challenge.id, { participants: [{ user, target: 100 }] }, user));
  assert.throws(() => editEntity(state, 'challenges', challenge.id, { historicalImport: {} }, user));
  assert.throws(() => joinEntity(state, 'challenges', challenge.id, user, { target: 100 }));
  assert.throws(() => setResult(state, challenge.id, user, { value: 50, sourceCell: 'AO9' }));
  assert.throws(() => setResult(state, challenge.id, user, { date: '2026-10-02', value: 20 }), { code: 'CHALLENGE_FINISHED' });
  assert.deepEqual(state, before);
});

test('pending values preserve participation history and lock their original unit without becoming scores', () => {
  const { state, user, challenge } = fixture();
  challenge.results = [];
  challenge.pendingResults = [{ user, value: 50, sourceCell: 'AO9', reason: 'Проверка даты' }];
  const before = structuredClone(state);
  assert.throws(() => leaveEntity(state, 'challenges', challenge.id, user), { code: 'RESULTS_EXIST' });
  assert.throws(() => editEntity(state, 'challenges', challenge.id, { category: 'distance' }, user), { code: 'CHALLENGE_METRIC_LOCKED' });
  assert.throws(() => editEntity(state, 'challenges', challenge.id, { goal: { target: 1000, unit: 'км' } }, user), { code: 'CHALLENGE_METRIC_LOCKED' });
  assert.deepEqual(state, before);
});
