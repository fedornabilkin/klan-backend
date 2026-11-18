import assert from 'node:assert/strict';
import test from 'node:test';
import { checkTelegramProduction, type TelegramReadClient } from './telegram-check.js';
import type { Config } from '../../../src/config.js';

const config: Config = { production: true, demo: false, port: 3001, origin: 'https://klan.example.org', botToken: 'not-real', botUsername: 'klan_test_bot', telegramGroups: ['-1001'], telegramGroupLevels: {}, adminTelegramIds: [], sessionTtlMs: 3600000 };
function client(overrides: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const results: Record<string, unknown> = { getMe: { id: 123, is_bot: true, username: 'klan_test_bot' }, getWebhookInfo: { url: '' }, getChat: { type: 'supergroup' }, getChatMember: { status: 'administrator' }, ...overrides };
  const request: TelegramReadClient = async <T>(method: string) => { calls.push(method); if (!(method in results)) throw new Error('Unexpected method'); return results[method] as T; };
  return { calls, request };
}

test('Production preflight performs only read-only bot/group checks', async () => {
  const fake = client();
  const result = await checkTelegramProduction(config, fake.request);
  assert.ok(result.every(check => check.ok));
  assert.deepEqual(fake.calls, ['getMe', 'getWebhookInfo', 'getChat', 'getChatMember']);
});

test('Preflight blocks unsafe environment, token mismatch, webhook and missing bot admin rights', async () => {
  const fake = client();
  assert.ok((await checkTelegramProduction({ ...config, demo: true }, fake.request)).some(check => !check.ok));
  assert.equal(fake.calls.length, 0);
  for (const overrides of [
    { getMe: { id: 123, is_bot: true, username: 'other_bot' } },
    { getWebhookInfo: { url: 'https://private.example/secret-webhook' } },
    { getChatMember: { status: 'member' } },
    { getChat: { type: 'channel' } },
  ]) {
    const result = await checkTelegramProduction(config, client(overrides).request);
    assert.ok(result.some(check => !check.ok));
    assert.ok(!JSON.stringify(result).includes('secret-webhook'));
  }
});

test('Preflight never returns raw network errors that can contain credentials', async () => {
  const result = await checkTelegramProduction(config, async () => { throw new Error('https://api.telegram.org/botSECRET/getMe'); });
  assert.ok(result.some(check => !check.ok));
  assert.ok(!JSON.stringify(result).includes('SECRET'));
});
