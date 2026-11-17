import test from 'node:test';
import assert from 'node:assert/strict';
import type { Entity, User } from '../../src/shared/contracts.js';
import { emptyState, MemoryRepository, type DatabaseState } from '../../src/repository.js';
import { planHistoricalChallengeImport } from './challenge-import.js';

const importedAt = '2026-11-13T14:00:00.000Z';
const options = { importedAt };
type ManifestRow = {
  sourceId: string; sourceRow: number; teamKey: string;
  existingUserId?: string;
  newUser?: { key: string; name: string; callsign: string; username?: string };
  expectedUser?: { name: string; username?: string };
  usernameToFill?: string; callsignToFill?: string; target?: number;
  results: { date: string; value: number; sourceCell: string }[];
  pendingResults: { value: number; sourceCell: string; reason: string }[];
};

function member(id: string, extra: Partial<User> = {}): User {
  return {
    id, publicId: id === 'one' ? 8 : 9, name: id === 'one' ? 'Иван Петров' : 'Павел Сидоров',
    role: 'member', bio: 'Сохранить мой текст', location: { city: 'Москва', country: 'Россия', lat: 55.75, lng: 37.61 },
    tags: [{ id: 'tag-original', name: 'IT' }], initials: 'ИП', color: '#123456',
    facts: [{ id: 'fact-kept', text: 'Мой факт', date: '2025-01-01' }], interests: ['Музыка'],
    achievements: [{ id: 'achievement-kept', text: 'Моё достижение', date: null }],
    stats: { events: 2, challenges: 3, books: 4 }, joinedAt: '2025-02-03T10:00:00.000Z',
    ...extra,
  };
}
function fixture(): DatabaseState {
  const state = emptyState();
  state.users = [member('one'), member('two', { username: 'other_user', callsign: 'Север' })];
  state.tags = [{ id: 'tag-original', name: 'IT' }];
  state.telegramUsers = { '12345': 'one', '67890': 'two' };
  state.sessions = { retained: { userId: 'one', expiresAt: '2026-12-01T00:00:00.000Z', source: 'telegram' } };
  state.authRequests = { pending: { browserHash: 'retained', status: 'pending', expiresAt: '2026-12-01T00:00:00.000Z' } };
  state.userPublicIds = { highWater: 60 };
  return state;
}
function row(extra: Partial<ManifestRow> = {}): ManifestRow {
  return {
    sourceId: 'source-row-43', sourceRow: 43, teamKey: 'alpha', existingUserId: 'one',
    expectedUser: { name: 'Иван Петров' }, target: 100,
    results: [{ date: '2026-10-02', value: 0, sourceCell: 'F43' }, { date: '2026-10-04', value: 35, sourceCell: 'H43' }],
    pendingResults: [{ value: 20, sourceCell: 'AJ43', reason: 'no_date_header' }], ...extra,
  };
}
function manifest(rows: ManifestRow[] = [row()]) {
  return {
    key: 'october-2026-toes-to-bar', sourceHash: 'a'.repeat(64),
    title: 'Подъём ног к перекладине — октябрь 2026', description: 'Результаты командного челленджа.',
    startDate: '2026-10-02', endDate: '2026-10-31', target: 200, unit: 'повторений',
    teams: [{ key: 'alpha', title: 'АЛЬФА', target: 100 }, { key: 'beta', title: 'БЕТА', target: 100 }],
    participants: rows,
  };
}
function challenge(state: DatabaseState): Entity {
  const result = state.entities.find(entity => entity.type === 'challenges');
  assert.ok(result);
  return result;
}
function expectRejectedWithoutMutation(input: unknown, state = fixture()) {
  const before = structuredClone(state);
  assert.throws(() => planHistoricalChallengeImport(state, input, options));
  assert.deepEqual(state, before);
}

test('historical preview is pure and keeps profiles, Telegram bindings and session data intact', () => {
  const before = fixture();
  const snapshot = structuredClone(before);
  const plan = planHistoricalChallengeImport(before, manifest(), options);
  assert.deepEqual(before, snapshot, 'dry-run must not change its input');
  assert.deepEqual(plan.state.users, snapshot.users);
  assert.deepEqual(plan.state.telegramUsers, snapshot.telegramUsers);
  assert.deepEqual(plan.state.sessions, snapshot.sessions);
  assert.deepEqual(plan.state.authRequests, snapshot.authRequests);
  assert.deepEqual(plan.state.tags, snapshot.tags);
  assert.equal(challenge(plan.state).status, 'completed');
  assert.equal(challenge(plan.state).category, 'count');
  assert.equal(plan.state.entities.filter(entity => entity.type === 'teams').length, 2);
});

test('blank identity contacts can be filled without rewriting any other profile fields', () => {
  const state = fixture();
  const original = structuredClone(state.users[0]!);
  const plan = planHistoricalChallengeImport(state, manifest([row({ usernameToFill: '@ivan_petrov', callsignToFill: 'Ветер' })]), options);
  const updated = plan.state.users.find(user => user.id === 'one')!;
  assert.deepEqual(updated, { ...original, username: 'ivan_petrov', callsign: 'Ветер' });
  assert.deepEqual(plan.state.users[1], state.users[1]);
  assert.deepEqual(plan.state.telegramUsers, state.telegramUsers, 'username is not a Telegram authentication identity');
});

test('contact collisions and stale reviewed identities reject the entire plan', () => {
  expectRejectedWithoutMutation(manifest([row({ usernameToFill: 'OTHER_USER' })]));
  expectRejectedWithoutMutation(manifest([row({ expectedUser: { name: 'Другое имя' } })]));
  const changedUsername = fixture();
  changedUsername.users[0]!.username = 'new_username';
  expectRejectedWithoutMutation(manifest([row({ expectedUser: { name: 'Иван Петров', username: 'old_username' }, usernameToFill: 'old_username' })]), changedUsername);
  expectRejectedWithoutMutation(manifest([
    row({ usernameToFill: 'fresh_handle' }),
    row({ sourceId: 'source-row-44', sourceRow: 44, existingUserId: undefined, expectedUser: undefined, newUser: { key: 'new-one', name: 'Новый Участник', callsign: '', username: 'FRESH_HANDLE' }, results: [], pendingResults: [] }),
  ]));
});

test('new profiles use deterministic identities and increasing public IDs without invented personal data', () => {
  const input = manifest([row({
    existingUserId: undefined, expectedUser: undefined,
    newUser: { key: 'new-member', name: 'Алексей Тестовый', callsign: 'Кедр', username: 'alexey_member' },
  })]);
  const first = planHistoricalChallengeImport(fixture(), input, options);
  const second = planHistoricalChallengeImport(fixture(), input, { importedAt: '2026-11-14T14:00:00.000Z' });
  const added = first.state.users.find(user => !['one', 'two'].includes(user.id))!;
  const secondAdded = second.state.users.find(user => !['one', 'two'].includes(user.id))!;
  assert.equal(added.id, secondAdded.id);
  assert.equal(added.publicId, 61);
  assert.equal(added.role, 'member');
  assert.equal(added.name, 'Алексей Тестовый');
  assert.equal(added.callsign, 'Кедр');
  assert.equal(added.username, 'alexey_member');
  assert.equal(added.bio, '');
  assert.equal(added.birthDate, undefined);
  assert.deepEqual(added.location, { city: '', country: '', lat: null, lng: null });
  assert.deepEqual(added.facts, []);
  assert.deepEqual(added.achievements, []);
  assert.deepEqual(added.tags, []);
  assert.equal(added.joinedAt, importedAt);
  assert.deepEqual(first.state.telegramUsers, fixture().telegramUsers);
});

test('a repeated import changes nothing and a changed reviewed manifest cannot overwrite its prior import', () => {
  const input = manifest([row({ usernameToFill: 'ivan_petrov' })]);
  const first = planHistoricalChallengeImport(fixture(), input, options);
  const second = planHistoricalChallengeImport(first.state, input, { importedAt: '2026-11-14T14:00:00.000Z' });
  assert.deepEqual(second.state, first.state);
  const changed = structuredClone(input);
  changed.participants[0]!.results[1]!.value = 100;
  expectRejectedWithoutMutation(changed, first.state);
  const changedSource = structuredClone(input);
  changedSource.sourceHash = 'b'.repeat(64);
  expectRejectedWithoutMutation(changedSource, first.state);
});

test('same-person duplicate rows preserve one participant and never double-count identical daily entries', () => {
  const repeated = row({ sourceId: 'source-row-44', sourceRow: 44, pendingResults: [], results: [{ date: '2026-10-04', value: 35, sourceCell: 'H44' }] });
  const plan = planHistoricalChallengeImport(fixture(), manifest([row(), repeated]), options);
  const imported = challenge(plan.state);
  assert.equal(imported.participants.length, 1);
  assert.equal(imported.participants[0]!.target, 100);
  assert.deepEqual(imported.results?.map(result => [result.date, result.value]), [['2026-10-02', 0], ['2026-10-04', 35]]);
  assert.equal(plan.state.entities.find(entity => entity.type === 'teams' && entity.title === 'АЛЬФА')!.participants.length, 1);
  const conflict = structuredClone(repeated);
  conflict.results[0]!.value = 36;
  expectRejectedWithoutMutation(manifest([row(), conflict]));
});

test('undated source values remain separate from dated totals and empty days stay absent', () => {
  const imported = challenge(planHistoricalChallengeImport(fixture(), manifest(), options).state);
  assert.equal(imported.results!.reduce((sum, result) => sum + result.value, 0), 35);
  assert.equal(imported.results!.length, 2);
  assert.equal(imported.results!.some(result => result.date === '2026-10-03'), false);
  assert.equal(imported.results![0]!.value, 0, 'explicit zero must remain');
  assert.equal(imported.pendingResults!.length, 1);
  assert.equal(imported.pendingResults![0]!.value, 20);
  assert.equal(imported.pendingResults![0]!.sourceCell, 'AJ43');
  assert.equal(imported.pendingResults![0]!.reason, 'no_date_header');
  assert.equal(imported.pendingResults![0]!.user.id, 'one');
  assert.equal(imported.pendingResults![0]!.team!.id, imported.participants[0]!.team!.id);
});

test('one active team per person is preserved both against the database and inside an import', () => {
  const state = fixture();
  state.entities.push({ id: 'prior-team', type: 'teams', title: 'ПРЕЖНЯЯ', description: '', status: 'active', category: '', tags: [], createdAt: importedAt, participants: [{ user: state.users[0]! }] });
  expectRejectedWithoutMutation(manifest(), state);
  expectRejectedWithoutMutation(manifest([row(), row({ sourceId: 'source-row-44', sourceRow: 44, teamKey: 'beta', results: [], pendingResults: [] })]));
  state.entities[0]!.status = 'archived';
  const plan = planHistoricalChallengeImport(state, manifest(), options);
  assert.equal(challenge(plan.state).participants.length, 1);
  assert.deepEqual(plan.state.entities.find(entity => entity.id === 'prior-team'), state.entities[0]);
});

test('invalid identity references and unknown team keys never produce partial imported data', () => {
  expectRejectedWithoutMutation(manifest([row({ existingUserId: 'absent' })]));
  expectRejectedWithoutMutation(manifest([row({ existingUserId: undefined, newUser: undefined })]));
  expectRejectedWithoutMutation(manifest([row({ newUser: { key: 'also-new', name: 'Другой Участник', callsign: '' } })]));
  expectRejectedWithoutMutation(manifest([row({ teamKey: 'missing' })]));
  expectRejectedWithoutMutation(manifest([row(), row()]));
});

test('one original source cell cannot be assigned to different people or both dated and pending records', () => {
  const another = row({
    sourceId: 'source-row-44', sourceRow: 44, existingUserId: 'two',
    expectedUser: { name: 'Павел Сидоров', username: 'other_user' },
    results: [{ date: '2026-10-02', value: 0, sourceCell: 'F43' }], pendingResults: [],
  });
  expectRejectedWithoutMutation(manifest([row(), another]));
  another.results = [];
  another.pendingResults = [{ value: 0, sourceCell: 'F43', reason: 'no_date_header' }];
  expectRejectedWithoutMutation(manifest([row(), another]));
});

test('calendar dates, period boundaries and integer repetition counts are validated before import', () => {
  for (const date of ['2026-10-01', '2026-11-01', '2026-02-30', '2026-10-32', '2026-10-02T00:00:00Z']) {
    expectRejectedWithoutMutation(manifest([row({ results: [{ date, value: 1, sourceCell: 'F43' }] })]));
  }
  for (const value of [-1, 1.5, NaN, Infinity]) {
    expectRejectedWithoutMutation(manifest([row({ results: [{ date: '2026-10-02', value, sourceCell: 'F43' }] })]));
    expectRejectedWithoutMutation(manifest([row({ pendingResults: [{ value, sourceCell: 'AJ43', reason: 'no_date_header' }] })]));
  }
  for (const target of [0, -1, NaN, Infinity]) expectRejectedWithoutMutation({ ...manifest(), target });
  expectRejectedWithoutMutation({ ...manifest(), startDate: '2026-11-01', endDate: '2026-10-31' });
});

test('a failure inside the repository transaction preserves the whole pre-import state', async () => {
  const initial = fixture();
  const repo = new MemoryRepository(initial);
  await assert.rejects(repo.write(state => {
    const plan = planHistoricalChallengeImport(state, manifest(), options);
    Object.assign(state, plan.state);
    throw new Error('backup failed before transaction committed');
  }), /backup failed/);
  assert.deepEqual(await repo.read(state => state), initial);
  await repo.close();
});
