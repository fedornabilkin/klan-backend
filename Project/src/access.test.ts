import assert from 'node:assert/strict';
import test from 'node:test';
import { accessForLevel, hasCapability, parseGroupLevels, requireCapability, resolveTelegramAccess } from './access.js';
import { readConfig } from './config.js';
import type { User } from './shared/contracts.js';

test('Group mappings are explicit, allowed-list bounded and reject unknown levels', () => {
  assert.deepEqual(parseGroupLevels(undefined, ['-1001']), {});
  assert.deepEqual(parseGroupLevels('{"-1001":"moderator"}', ['-1001']), { '-1001': 'moderator' });
  for (const input of ['null', '[]', '{"-1002":"admin"}', '{"-1001":"owner"}', 'broken']) {
    assert.throws(() => parseGroupLevels(input, ['-1001']));
  }
});

test('Highest matched group wins and admin IDs never bypass allowed-group membership', () => {
  assert.equal(resolveTelegramAccess([], {}, true), undefined);
  assert.equal(resolveTelegramAccess(['-1001'], {}, false)?.level, 'member');
  assert.equal(resolveTelegramAccess(['-1001', '-1002'], { '-1002': 'moderator' }, false)?.level, 'moderator');
  assert.equal(resolveTelegramAccess(['-1001', '-1002'], { '-1001': 'admin', '-1002': 'moderator' }, false)?.level, 'admin');
  assert.equal(resolveTelegramAccess(['-1001'], {}, true)?.level, 'admin');
});

test('Capabilities separate catalog moderators from private analytics and member administration', () => {
  const moderator = { role: 'member', access: accessForLevel('moderator', 'telegram') } as User;
  assert.equal(hasCapability(moderator, 'catalog.manage'), true);
  assert.equal(hasCapability(moderator, 'content.manage'), true);
  assert.equal(hasCapability(moderator, 'analytics.read'), false);
  assert.throws(() => requireCapability(moderator, 'members.manage'), { status: 403 });
  assert.equal(hasCapability({ role: 'admin' } as User, 'analytics.read'), true);
  assert.equal(hasCapability(undefined, 'community.read'), false);
  const demoted = { role: 'admin', access: accessForLevel('member', 'telegram') } as User;
  assert.equal(hasCapability(demoted, 'analytics.read'), false, 'computed access takes precedence over legacy stored role');
});

test('Production config rejects demo, non-HTTPS and malformed Telegram policy', () => {
  const env = { NODE_ENV: 'production', APP_ORIGIN: 'https://klan.example.org', DATABASE_URL: 'postgresql://local/klan', TELEGRAM_GROUP_IDS: '-1001', BOT_INTERNAL_SECRET: 'test-service-secret-'.repeat(3) };
  assert.equal(readConfig(env).membershipTtlMs, 60_000);
  for (const patch of [
    { DEMO_MODE: 'true' }, { APP_ORIGIN: 'http://klan.example.org' }, { TELEGRAM_GROUP_IDS: 'a-group' },
    { TELEGRAM_GROUP_IDS: '' }, { TELEGRAM_REQUIRE_GROUP_MEMBERSHIP: 'of' },
    { TELEGRAM_ADMIN_IDS: '-1001' }, { TELEGRAM_GROUP_LEVELS: '{"-1002":"admin"}' },
    { TELEGRAM_MEMBERSHIP_TTL_SECONDS: '600' }, { TELEGRAM_MEMBERSHIP_TTL_SECONDS: '15.5' },
  ]) assert.throws(() => readConfig({ ...env, ...patch }));
});

test('Local demo profile and privileges are explicit server configuration', () => {
  const config = readConfig({ DEMO_MODE: 'true', DEMO_USER_ID: '  profile-1  ' });
  assert.equal(config.demoUserId, 'profile-1');
  assert.equal(config.demoAccessLevel, 'member');
  assert.equal(readConfig({ DEMO_MODE: 'true', DEMO_USER_ID: 'profile-1', DEMO_ACCESS_LEVEL: 'admin' }).demoAccessLevel, 'admin');
  assert.throws(() => readConfig({ DEMO_MODE: 'true', DEMO_USER_ID: '@someone' }));
  assert.throws(() => readConfig({ DEMO_MODE: 'true', DEMO_ACCESS_LEVEL: 'owner' }));
});
