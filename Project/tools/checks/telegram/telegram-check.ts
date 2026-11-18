import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { backendRoot } from '../../paths.js';
import { config as loadEnv } from 'dotenv';
import { readConfig, type Config } from '../../../src/config.js';

export interface TelegramCheck { name: string; ok: boolean; message: string }
export type TelegramReadClient = <T>(method: string, payload: object) => Promise<T>;
interface Bot { id: number; is_bot: boolean; username?: string }
interface Chat { type: string }
interface Member { status: string }

function readOnlyClient(token: string): TelegramReadClient {
  const methods = new Set(['getMe', 'getWebhookInfo', 'getChat', 'getChatMember']);
  return async <T>(method: string, payload: object) => {
    if (!methods.has(method)) throw new Error('Preflight permits only read-only Telegram checks');
    try {
      const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(12000),
      });
      const body = await response.json() as { ok: boolean; result?: T };
      if (!response.ok || !body.ok || body.result === undefined) throw new Error('Rejected');
      return body.result;
    } catch { throw new Error(`Telegram не подтвердил проверку ${method}. Проверьте токен, сеть и права бота.`); }
  };
}

/** Does not send messages, consume updates, change webhooks, create sessions or access PostgreSQL. */
export async function checkTelegramProduction(config: Config, client?: TelegramReadClient): Promise<TelegramCheck[]> {
  const checks: TelegramCheck[] = [];
  const requireMembership = config.telegramGroupMembershipRequired !== false;
  const ready = config.production && !config.demo && config.origin.startsWith('https://')
    && !!config.botToken && !!config.botUsername && (!requireMembership || config.telegramGroups.length > 0);
  checks.push({ name: 'configuration', ok: ready, message: ready
    ? 'Production, HTTPS, DEMO_MODE=false и параметры бота заданы.'
    : 'Нужны production, HTTPS, параметры бота и список групп, если включена проверка членства.' });
  if (!ready) return checks;
  const request = client ?? readOnlyClient(config.botToken!);
  let bot: Bot;
  try {
    bot = await request<Bot>('getMe', {});
    const matches = bot.is_bot && Number.isSafeInteger(bot.id) && bot.id > 0 && bot.username?.toLowerCase() === config.botUsername!.toLowerCase();
    checks.push({ name: 'bot', ok: !!matches, message: matches ? 'Токен соответствует настроенному username бота.' : 'Токен и TELEGRAM_BOT_USERNAME не соответствуют одному боту.' });
    if (!matches) return checks;
  } catch {
    checks.push({ name: 'bot', ok: false, message: 'Telegram не подтвердил бота. Проверьте токен и исходящий HTTPS-доступ.' });
    return checks;
  }
  try {
    const webhook = await request<{ url: string }>('getWebhookInfo', {});
    checks.push({ name: 'polling', ok: !webhook.url, message: webhook.url
      ? 'У бота настроен webhook. Для long polling его нужно отключить отдельно; эта проверка ничего не меняет.'
      : 'Webhook отсутствует: можно использовать один экземпляр long polling.' });
  } catch { checks.push({ name: 'polling', ok: false, message: 'Не удалось проверить настройку webhook.' }); }
  if (!requireMembership) return checks;
  for (const [index, group] of config.telegramGroups.entries()) {
    try {
      const chat = await request<Chat>('getChat', { chat_id: group });
      const membership = await request<Member>('getChatMember', { chat_id: group, user_id: bot.id });
      const validType = ['group', 'supergroup'].includes(chat.type);
      const administrator = ['creator', 'administrator'].includes(membership.status);
      checks.push({ name: `group-${index + 1}`, ok: validType && administrator, message: !validType
        ? 'Указан не групповой чат. Проверьте TELEGRAM_GROUP_IDS.'
        : administrator ? `Группа доступна; бот — администратор; уровень участников: ${config.telegramGroupLevels?.[group] ?? 'member'}.`
          : 'Боту нужны права администратора группы для надёжной проверки членства других пользователей.' });
    } catch { checks.push({ name: `group-${index + 1}`, ok: false, message: 'Группа недоступна боту. Проверьте числовой ID и участие бота.' }); }
  }
  return checks;
}

async function main() {
  try {
    loadEnv({ path: resolve(backendRoot, process.env.DOTENV_CONFIG_PATH || '.env'), quiet: true });
    // Compose names the container connection separately; this preflight never connects to it.
    const checks = await checkTelegramProduction(readConfig({ ...process.env, DATABASE_URL: process.env.DATABASE_URL || process.env.CONTAINER_DATABASE_URL }));
    for (const check of checks) console.log(`${check.ok ? 'OK' : 'FAIL'} ${check.name}: ${check.message}`);
    if (checks.some(check => !check.ok)) process.exitCode = 1;
    else console.log('Предварительные проверки пройдены. Реальный вход участника и отказ постороннему проверяются в браузере по Docs/telegram-acceptance.md.');
  } catch (error) {
    // Config errors have fixed messages and never embed credential values.
    console.error(error instanceof Error ? error.message : 'Не удалось проверить конфигурацию Telegram.');
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) void main();
