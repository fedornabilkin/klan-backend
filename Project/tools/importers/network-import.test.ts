import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareNetworkImport, applyNetworkImport, type SourceInfo, type NetworkEnrichment } from './network-import.js';
import { emptyState } from '../../src/repository.js';
import { createSeed } from '../../src/seed.js';
import { profileEntryText } from '../../src/shared/profile-entries.js';

const info: SourceInfo = { sourceHash: 'a'.repeat(64), importedAt: '2026-11-11T16:00:00.000Z', sourceName: 'network.json' };
function node(id: number, facts: string[], overrides: Record<string, unknown> = {}) {
  return { id, uid: `node-${id}`, name: `Person ${id}`, description: '  Original bio\nnot trimmed  ',
    facts: facts.map(description => ({ description })), tags: [1], ...overrides };
}
const source = (nodes: object[], tags = [{ id: 1, name: 'Спорт' }]) => ({ meta: { exportedAt: '2000-01-01' }, payload: { nodes, tags, links: [{ source: 1, target: 2 }] } });

test('selects personal standalone handles in facts; avoids email, descriptions, channels and ambiguous links', () => {
  const plan = prepareNetworkImport(source([
    node(1, ['user@example.com', 'call +7 123 @Person_One', '@secondary_contact']),
    node(2, ['user@example.com'], { description: '@NotAContact' }),
    node(3, ['Telegram канал: @PublicChannel']),
    node(4, ['Мой личный профиль: https://t.me/PersonalLink']),
    node(5, ['Канал: https://t.me/PublicChannel']),
    node(6, ['https://t.me/AmbiguousLink']),
    node(7, ['@FirstPerson @Other_blog user@example.com']),
    node(8, ['@SecondPerson', 't.me/SampleChannel']),
    node(9, ['Telegram: t.me/joinchat/abc']),
  ]), [], info);
  assert.deepEqual(plan.profiles.map(profile => profile.username), ['Person_One', 'PersonalLink', 'FirstPerson', 'SecondPerson']);
  assert.equal(plan.summary.excluded, 5);
  assert.equal(plan.summary.linkContacts, 1);
  assert.deepEqual(plan.profiles[2]!.facts.map(profileEntryText), ['@FirstPerson @Other_blog user@example.com']);
});

test('preserves original facts and bio without importing external profile classifications', () => {
  const originalFacts = ['@full_profile', '  phone +7 123; ДР 2009  ', 'x'.repeat(282), '', '   '];
  const raw = node(1, originalFacts, { x: 43, y: 20, fill: '#ff0000', createdAt: '1980-01-01',
    pcm: { filter: { label: 'Логик' } }, pcmHint: { filter: 'empath', confidence: 'high' } });
  const plan = prepareNetworkImport(source([raw]), [], info);
  const profile = plan.profiles[0]!;
  assert.equal(profile.bio, raw.description);
  assert.deepEqual(profile.facts.map(profileEntryText), originalFacts.slice(0, 3));
  assert.ok(profile.facts.every(fact => typeof fact !== 'string' && fact.date === null));
  assert.equal(plan.summary.maxFactLength, 282);
  assert.equal(profile.joinedAt, info.importedAt);
  assert.equal(profile.id, 'member-node-1');
  assert.equal(profile.color, '#b57439');
  for (const key of ['x', 'y', 'fill', 'pcmHint', 'links', 'birthDate', 'createdAt']) assert.equal(key in profile, false);
  assert.deepEqual(Object.keys(profile.importProvenance).sort(), ['importedAt', 'importer', 'nodeUid', 'sourceHash', 'sourceId', 'sourceName', 'version']);
});

test('explicit self override is a member profile and never merges a same-name demo administrator', () => {
  const state = createSeed();
  const admin = state.users[0]!;
  admin.name = 'Тестовый Владелец';
  const oldAdmin = structuredClone(admin);
  const previousNames = state.users.filter(user => user.name === 'Тестовый Владелец').length;
  const selfSource = source([node(1, ['Original self fact'], { name: 'Я', role: 'admin', access: { level: 'admin' } })]);
  assert.throws(() => prepareNetworkImport(selfSource, [], info), { code: 'SELF_IDENTITY_REQUIRED' });
  const plan = prepareNetworkImport(selfSource, [], info, { name: 'Тестовый Владелец', username: 'test_owner' });
  assert.equal(plan.profiles[0]!.name, 'Тестовый Владелец');
  assert.equal(plan.profiles[0]!.username, 'test_owner');
  assert.equal(plan.profiles[0]!.role, 'member');
  assert.equal(plan.profiles[0]!.access, undefined);
  const authBefore = JSON.stringify([state.telegramUsers, state.sessions, state.authRequests]);
  const result = applyNetworkImport(state, plan);
  assert.equal(result.addedUsers, 1);
  assert.deepEqual(state.users[0], oldAdmin);
  assert.equal(state.users.filter(user => user.name === 'Тестовый Владелец').length, previousNames + 1);
  assert.equal(JSON.stringify([state.telegramUsers, state.sessions, state.authRequests]), authBefore);
});

test('only explicit, evidenced and geocoded cities get coordinates; country-only evidence stays useful', () => {
  const enrichments: NetworkEnrichment[] = [
    { sourceId: 1, city: 'Москва', country: 'Россия', evidence: 'Живет в Москве', certainty: 'explicit', lat: 55.75, lng: 37.62, geonameId: 524901, interests: ['Бег'], achievements: ['Марафон'] },
    { sourceId: 2, city: 'Москва', country: 'Россия', evidence: 'Возможно Москва', certainty: 'uncertain', lat: 55.75, lng: 37.62, geonameId: 524901 },
    { sourceId: 3, city: null, country: 'Россия', evidence: 'МО', certainty: 'explicit', lat: null, lng: null },
    { sourceId: 4, city: 'Москва', country: 'Россия', evidence: 'Москва', certainty: 'explicit', lat: 55.75, lng: 37.62 },
    { sourceId: 5, city: 'Москва', country: 'Россия', evidence: 'Москва', certainty: 'explicit', lat: 95, lng: 37.62, geonameId: 524901 },
  ];
  const plan = prepareNetworkImport(source([1, 2, 3, 4, 5].map(id => node(id, [`@person_${id}`]))), enrichments, info);
  assert.deepEqual(plan.profiles[0]!.location, { city: 'Москва', country: 'Россия', lat: 55.75, lng: 37.62 });
  assert.deepEqual(plan.profiles[1]!.location, { city: '', country: 'Россия', lat: null, lng: null });
  assert.deepEqual(plan.profiles[2]!.location, { city: '', country: 'Россия', lat: null, lng: null });
  assert.equal(plan.profiles[3]!.location.lat, null);
  assert.equal(plan.profiles[4]!.location.lat, null);
  assert.deepEqual(plan.profiles[0]!.interests, ['Бег']);
  assert.equal(plan.summary.mappedLocations, 1);
});

test('reuses Unicode/case-normalized existing tags and imports only tags used by selected profiles', () => {
  const state = emptyState();
  state.tags.push({ id: 'old-tag', name: 'ＩＴ' });
  const originalTag = structuredClone(state.tags[0]);
  const plan = prepareNetworkImport(source([node(1, ['@person_one'], { tags: [1, 2, 3] }), node(2, ['no contact'], { tags: [4] })],
    [{ id: 1, name: 'IT' }, { id: 2, name: 'it' }, { id: 3, name: ' Спорт ' }, { id: 4, name: 'Unused' }]), [], info);
  assert.equal(plan.summary.tagsUsed, 2);
  const result = applyNetworkImport(state, plan);
  assert.equal(result.addedTags, 1);
  assert.deepEqual(state.tags[0], originalTag);
  assert.deepEqual(state.users[0]!.tags[0], originalTag);
  assert.equal(state.users[0]!.tags.length, 2);
  assert.ok(!state.tags.some(tag => tag.name === 'Unused'));
});

test('all username and ID conflicts are rejected before any mutation', () => {
  const plan = prepareNetworkImport(source([node(1, ['@safe_user']), node(2, ['@conflict_user'])]), [], info);
  const state = emptyState();
  const conflict = structuredClone(plan.profiles[1]!);
  conflict.id = 'existing-user';
  conflict.username = '@CONFLICT_USER';
  delete (conflict as Partial<typeof conflict>).importProvenance;
  state.users.push(conflict);
  const before = JSON.stringify(state);
  assert.throws(() => applyNetworkImport(state, plan), { code: 'USERNAME_CONFLICT' });
  assert.equal(JSON.stringify(state), before);
  conflict.username = 'another_user';
  conflict.id = plan.profiles[1]!.id;
  const beforeId = JSON.stringify(state);
  assert.throws(() => applyNetworkImport(state, plan), { code: 'ID_CONFLICT' });
  assert.equal(JSON.stringify(state), beforeId);
  assert.throws(() => prepareNetworkImport(source([node(1, ['@same_user']), node(2, ['@Same_User'])]), [], info), { code: 'DUPLICATE_USERNAME' });
});

test('rerun is a no-op without changing current profiles; a changed source requires review', () => {
  const plan = prepareNetworkImport(source([node(1, ['@person_one'])]), [], info);
  const state = emptyState();
  applyNetworkImport(state, plan);
  state.users[0]!.bio = 'Later profile edits must survive rerun';
  const before = JSON.stringify(state);
  assert.deepEqual(applyNetworkImport(state, plan), { addedUsers: 0, addedTags: 0, skippedUsers: 1, noop: true });
  assert.equal(JSON.stringify(state), before);
  const changed = prepareNetworkImport(source([node(1, ['@person_one']), node(2, ['@person_two'])]), [], { ...info, sourceHash: 'b'.repeat(64) });
  assert.throws(() => applyNetworkImport(state, changed), { code: 'SOURCE_CHANGED' });
  assert.equal(JSON.stringify(state), before);
});

test('tampered plan cannot elevate permissions and invalid tag references cannot partially append', () => {
  const state = emptyState();
  const plan = prepareNetworkImport(source([node(1, ['@person_one'])]), [], info);
  plan.profiles[0]!.role = 'admin';
  assert.throws(() => applyNetworkImport(state, plan), { code: 'UNSAFE_IMPORT_PLAN' });
  plan.profiles[0]!.role = 'member';
  plan.profiles[0]!.tags.push({ id: 'absent', name: 'Absent' });
  assert.throws(() => applyNetworkImport(state, plan), { code: 'UNKNOWN_IMPORT_TAG' });
  assert.deepEqual(state, emptyState());
});

test('keeps existing member links across importer versions', () => {
  const plan = prepareNetworkImport(source([node(1, ['@person_one'])]), [], info);
  const state = emptyState();
  const legacy = structuredClone(plan.profiles[0]!);
  legacy.id = 'pcm-node-1';
  legacy.importProvenance.importer = 'pcm-helper';
  state.users.push(legacy);
  assert.equal(applyNetworkImport(state, plan).skippedUsers, 1);
  assert.deepEqual(state.users.map(user => user.id), ['pcm-node-1']);
});
