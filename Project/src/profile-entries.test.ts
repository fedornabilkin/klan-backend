import test from 'node:test';
import assert from 'node:assert/strict';
import type { ProfileEntry } from './shared/contracts.js';
import { isCalendarDate, normalizeProfileEntries, profileEntryText } from './shared/profile-entries.js';
import { addActivity, getUser, hydrateEntity, hydrateUser, listResource, querySchema, updateProfile } from './domain.js';
import { analyticsProfileFields, memberAnalytics, parseAnalyticsRange } from './analytics.js';
import { createSeed } from './seed.js';

test('legacy profile hydration is lossless, repeatable and does not mutate stored records or infer dates', () => {
  const state = createSeed();
  const user = state.users[1]!;
  user.facts = ['  ДР 2009, @handle_123  ', 'Ф'.repeat(282), 'Повтор', 'Повтор'];
  user.achievements = ['Марафон 21.09.1985'];
  const before = structuredClone(user);
  const first = hydrateUser(state, user);
  const second = hydrateUser(state, user);
  assert.deepEqual(first.facts.map(profileEntryText), user.facts);
  assert.deepEqual(first.facts, second.facts);
  assert.equal(new Set((first.facts as ProfileEntry[]).map(entry => entry.id)).size, user.facts.length);
  assert.ok([...first.facts, ...first.achievements].every(entry => typeof entry !== 'string' && entry.date === null));
  assert.deepEqual(user, before);
  const entity = state.entities.find(entity => entity.participants.some(participant => participant.user.id === user.id))!;
  assert.deepEqual(hydrateEntity(state, entity).participants.find(participant => participant.user.id === user.id)!.user.facts, first.facts);
});

test('all 321 legacy facts survive read normalization across profiles, including repeated strings', () => {
  const state = createSeed();
  const strings = Array.from({ length: 321 }, (_, index) => index % 4 ? `Факт ${index}` : 'Повторяющийся факт');
  for (let index = 0; index < 4; index++) state.users[index]!.facts = strings.slice(index * 100, (index + 1) * 100);
  const result = state.users.slice(0, 4).flatMap(user => hydrateUser(state, user).facts.map(profileEntryText));
  assert.deepEqual(result, strings);
});

test('dated entries can be added, edited, reordered and removed while preserving identity and unrelated profile data', () => {
  const state = createSeed(); const user = state.users[1]!;
  user.facts = ['Старый факт'];
  const originalInterests = structuredClone(user.interests);
  const oldFact = normalizeProfileEntries(user.facts, `${user.id}:facts`)[0]!;
  const newFact: ProfileEntry = { id: 'new-fact', text: 'Первый поход', date: '2024-02-29' };
  let result = updateProfile(state, user.id, { facts: [oldFact, newFact], achievements: [{ id: 'prize', text: 'Марафон', date: '2025-06-01' }] }, user);
  assert.deepEqual(result.facts, [oldFact, newFact]);
  result = updateProfile(state, user.id, { facts: [{ ...newFact, text: 'Первый горный поход', date: null }, oldFact] }, user);
  assert.equal((result.facts[0] as ProfileEntry).id, newFact.id);
  assert.equal((result.facts[0] as ProfileEntry).date, null);
  assert.equal((result.achievements[0] as ProfileEntry).date, '2025-06-01');
  result = updateProfile(state, user.id, { facts: [oldFact] }, user);
  assert.deepEqual(result.facts, [oldFact]);
  assert.deepEqual(user.interests, originalInterests);
  assert.equal((result.achievements[0] as ProfileEntry).id, 'prize');
});

test('write validation rejects impossible dates, duplicate IDs and oversized input before changing a profile', () => {
  const state = createSeed(); const user = state.users[1]!;
  const before = JSON.stringify(user);
  const entry = { id: 'entry-1', text: 'Текст', date: null };
  for (const date of ['2025-02-29', '2026-02-30', '2026-13-01', '0000-01-01', '2026-1-01', '2026-01-01T00:00:00Z', '']) {
    assert.throws(() => updateProfile(state, user.id, { facts: [{ ...entry, date }] }, user));
    assert.equal(JSON.stringify(user), before);
  }
  for (const facts of [[entry, entry], [{ ...entry, text: ' ' }], [{ ...entry, text: 'Ф'.repeat(1001) }], Array.from({ length: 101 }, (_, index) => ({ ...entry, id: `id-${index}` }))]) {
    assert.throws(() => updateProfile(state, user.id, { bio: 'Must not be applied', facts }, user));
    assert.equal(JSON.stringify(user), before);
  }
  assert.equal(isCalendarDate('2000-02-29'), true);
  assert.equal(isCalendarDate('1900-02-29'), false);
  assert.equal(updateProfile(state, user.id, { achievements: [{ ...entry, text: 'Д'.repeat(1000), date: '2000-02-29' }] }, user).achievements.length, 1);
});

test('legacy imports and mixed arrays preserve text and dates; existing IDs never collide with generated IDs', () => {
  const state = createSeed(); const user = state.users[1]!;
  const existing = normalizeProfileEntries(['Same'], `${user.id}:facts`)[0]!;
  const result = updateProfile(state, user.id, { facts: ['Same', existing, 'Another'], achievements: ['  Original spaces  '] }, user);
  assert.deepEqual(result.facts.map(profileEntryText), ['Same', 'Same', 'Another']);
  assert.equal(new Set((result.facts as ProfileEntry[]).map(entry => entry.id)).size, 3);
  assert.equal((result.facts[1] as ProfileEntry).id, existing.id);
  assert.equal((result.achievements[0] as ProfileEntry).text, '  Original spaces  ');
});

test('object entry text remains searchable and counted by analytics without object stringification', () => {
  const state = createSeed(); const user = state.users[1]!;
  user.publicId = 42;
  updateProfile(state, user.id, { facts: [{ id: 'fact', text: 'Уникальная геология', date: null }], achievements: [{ id: 'award', text: 'Золотая медаль', date: '2025-05-05' }] }, user);
  assert.equal(listResource(state, 'users', querySchema.parse({ q: 'геология' })).meta.total, 1);
  assert.equal(listResource(state, 'users', querySchema.parse({ q: 'Золотая медаль' })).meta.total, 1);
  assert.equal(listResource(state, 'users', querySchema.parse({ q: '[object Object]' })).meta.total, 0);
  assert.ok(analyticsProfileFields(user).find(field => field.label === 'Достижения')?.filled);
  const range = parseAnalyticsRange({ from: '2026-11-01', to: '2026-11-11' }, new Date('2026-11-11T12:00:00Z'));
  const report = memberAnalytics(state, '42', range, {});
  assert.deepEqual(report, memberAnalytics(state, user.id, range, {}));
  assert.equal(report.member.current.achievements, 1);
  assert.equal(report.member.user.publicId, 42);
});

test('public profile IDs resolve safely and cannot be changed or used to bypass ownership', () => {
  const state = createSeed(); const user = state.users[1]!;
  user.publicId = 42;
  assert.equal(getUser(state, '42'), user);
  assert.equal(getUser(state, user.id), user);
  assert.equal(addActivity(state, user, 'updated').actor.publicId, 42);
  assert.equal(updateProfile(state, '42', { bio: 'Own profile' }, user).id, user.id);
  assert.throws(() => updateProfile(state, '42', { bio: 'Not own' }, state.users[2]!), { code: 'FORBIDDEN' });
  assert.throws(() => updateProfile(state, user.id, { publicId: 1 }, user));
  for (const invalid of ['0', '-42', '42.0', '1e1', '9007199254740992']) assert.throws(() => getUser(state, invalid), { code: 'NOT_FOUND' });
});
