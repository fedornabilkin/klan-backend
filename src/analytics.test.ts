import test from 'node:test';
import assert from 'node:assert/strict';
import type { Activity, Entity, User } from './shared/contracts.js';
import { emptyState } from './repository.js';
import { analyticsProfileFields, communityAnalytics, memberAnalytics, membersAnalytics, parseAnalyticsRange } from './analytics.js';

const now = new Date('2026-11-11T12:00:00Z');
const range = parseAnalyticsRange({ from: '2026-11-01', to: '2026-11-03' }, now);
const user = (id: string, name: string, joinedAt = '2026-01-01T00:00:00Z'): User => ({
  id, name, role: 'member', bio: '', initials: name[0]!, color: '#abc', joinedAt,
  location: { city: 'Москва', country: 'Россия', lat: 55, lng: 37 }, tags: [], facts: [], interests: [], achievements: [],
  stats: { events: 999, challenges: 999, books: 999 },
});
const action = (id: string, actor: User, createdAt: string, verb = 'вошёл в сообщество'): Activity => ({ id, actor, createdAt, action: verb });
const entity = (id: string, type: Entity['type'], participants: User[]): Entity => ({
  id, type, title: id, description: '', status: 'active', category: '', createdAt: '2026-01-01T00:00:00Z', tags: [], participants: participants.map(user => ({ user })),
});
function fixture() {
  const state = emptyState();
  const alice = user('a', 'Анна', '2026-11-02T23:00:00-03:00');
  const boris = user('b', 'Борис');
  const charlie = user('c', 'Виктор');
  const deleted = user('deleted', 'Удалённый');
  state.users.push(alice, boris, charlie);
  state.activities.push(
    action('old', alice, '2026-10-31T23:59:59.999Z'),
    action('a1', alice, '2026-11-01T00:00:00.000Z'),
    action('a2', alice, '2026-11-01T09:00:00Z', 'обновил профиль'),
    action('a3', alice, '2026-11-03T23:59:59.999Z'),
    action('b1', boris, '2026-11-03T15:00:00Z'),
    action('offset', boris, '2026-11-04T01:00:00+03:00'),
    action('future', alice, '2026-11-04T00:00:00Z'),
    action('gone', deleted, '2026-11-02T12:00:00Z'),
  );
  const event = entity('event', 'events', [alice, boris]);
  const repetitions = { ...entity('reps', 'challenges', [alice, charlie]), goal: { target: 100, unit: 'повторений' }, results: [
    { user: alice, date: '2026-10-31', value: 5 }, { user: alice, date: '2026-11-01', value: 10 }, { user: alice, date: '2026-11-02', value: 20 },
  ] };
  const kilometers = { ...entity('distance', 'challenges', [alice]), goal: { target: 10, unit: 'км' }, results: [{ user: alice, date: '2026-11-03', value: 2 }] };
  const book = { ...entity('book', 'books', []), readers: [alice] };
  state.entities.push(event, repetitions, kilometers, book, entity('team', 'teams', [boris]));
  return state;
}

test('analytics dates are real, bounded inclusive UTC days and default to last 30 days', () => {
  assert.deepEqual(parseAnalyticsRange({}, now), { from: '2026-10-13', to: '2026-11-11', days: 30, timezone: 'UTC' });
  assert.equal(parseAnalyticsRange({ from: '2024-02-29', to: '2024-02-29' }, now).days, 1);
  assert.throws(() => parseAnalyticsRange({ from: '2026-02-30' }, now));
  assert.throws(() => parseAnalyticsRange({ from: '2026-11-03', to: '2026-11-01' }, now));
  assert.throws(() => parseAnalyticsRange({ from: '2025-01-01', to: '2026-11-11' }, now));
  assert.throws(() => parseAnalyticsRange({ to: '2026-11-12' }, now));
  assert.throws(() => parseAnalyticsRange({ from: ['2026-11-01'] }, now));
});

test('community analytics includes boundaries and offset timestamps, excludes deleted actors from active membership', () => {
  const report = communityAnalytics(fixture(), range);
  assert.equal(report.period.actions, 6);
  assert.equal(report.period.activeMembers, 2);
  assert.equal(report.period.inactiveMembers, 1);
  assert.equal(report.period.activeMemberPercent, 67);
  assert.equal(report.period.newMembers, 1);
  assert.deepEqual(report.daily.map(point => [point.date, point.actions, point.activeMembers, point.newMembers]), [
    ['2026-11-01', 2, 1, 0], ['2026-11-02', 1, 0, 0], ['2026-11-03', 3, 2, 1],
  ]);
  assert.equal(report.coverage.firstRecordedActivity, '2026-10-31T23:59:59.999Z');
  assert.equal(report.coverage.storedActions, 8);
});

test('challenge values stay separated by challenge and unit; snapshots use actual relationships rather than cached stats', () => {
  const report = communityAnalytics(fixture(), range);
  assert.deepEqual(report.challenges.map(challenge => [challenge.id, challenge.unit, challenge.periodValue, challenge.totalValue]), [
    ['reps', 'повторений', 30, 35], ['distance', 'км', 2, 2],
  ]);
  assert.equal(report.period.resultEntries, 3);
  assert.equal(report.period.resultContributors, 1);
  assert.equal(report.current.eventRegistrations, 2);
  assert.equal(report.current.challengeRegistrations, 3);
  assert.equal(report.current.bookReadMarks, 1);
  assert.equal(report.current.activeTeams, 1);
});

test('members support activity filtering, search, stable pagination and null last activity', () => {
  const state = fixture();
  const first = membersAnalytics(state, range, { sort: '-actions', limit: 1 });
  const second = membersAnalytics(state, range, { sort: '-actions', limit: 1, page: 2 });
  assert.equal(first.data[0]?.user.id, 'a');
  assert.equal(second.data[0]?.user.id, 'b');
  assert.deepEqual(first.meta, { page: 1, limit: 1, total: 3, pages: 3 });
  const inactive = membersAnalytics(state, range, { activity: 'inactive' });
  assert.equal(inactive.data[0]?.user.id, 'c');
  assert.equal(inactive.data[0]?.lastRecordedActivity, null);
  assert.equal(membersAnalytics(state, range, { q: 'Борис Москва' }).meta.total, 1);
  assert.equal(membersAnalytics(state, range, { activity: 'active' }).meta.total, 2);
  assert.throws(() => membersAnalytics(state, range, { sort: 'password' }));
});

test('member detail restricts chronology and results to selected member and correctly pages history', () => {
  const detail = memberAnalytics(fixture(), 'a', range, { activityLimit: 2, activityPage: 2 });
  assert.equal(detail.member.period.actions, 3);
  assert.equal(detail.member.period.activeDays, 2);
  assert.equal(detail.member.period.resultEntries, 3);
  assert.equal(detail.member.lastRecordedActivity, '2026-11-04T00:00:00Z');
  assert.deepEqual(detail.member.current, { events: 1, challenges: 2, teams: 0, books: 1, achievements: 0 });
  assert.deepEqual(detail.activity.data.map(activity => activity.id), ['a1']);
  assert.equal(detail.activity.meta.total, 3);
  assert.deepEqual(detail.challenges.map(challenge => challenge.periodValue), [30, 2]);
  assert.equal(detail.profileFields.filter(field => field.filled).length, 3);
  assert.equal(detail.member.profileCompleteness, 38);
  assert.throws(() => memberAnalytics(fixture(), 'missing', range, {}));
});

test('empty community produces zeros and a complete zero-filled timeline without fabricated usage', () => {
  const state = emptyState();
  const report = communityAnalytics(state, range);
  assert.equal(report.period.activeMemberPercent, 0);
  assert.equal(report.current.averageProfileCompleteness, 0);
  assert.equal(report.coverage.firstRecordedActivity, null);
  assert.equal(report.daily.length, 3);
  assert.ok(report.daily.every(point => point.actions === 0));
  assert.deepEqual(membersAnalytics(state, range, {}).data, []);
  assert.equal(analyticsProfileFields(user('a', 'Анна')).length, 8);
});
