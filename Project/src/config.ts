import 'dotenv/config';
import { parseGroupLevels, type GroupLevels } from './access.js';

export interface Config {
  port: number; demo: boolean; production: boolean; origin: string; databaseUrl?: string; demoDatabaseUrl?: string;
  botToken?: string; botUsername?: string; telegramGroups: string[]; adminTelegramIds: string[]; sessionTtlMs: number;
  telegramGroupLevels?: GroupLevels; membershipTtlMs?: number;
  demoUserId?: string; demoAccessLevel?: 'member' | 'admin';
  botInternalSecret?: string; demoDataFile?: string;
}
export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const production = env.NODE_ENV === 'production';
  const demo = env.DEMO_MODE === 'true';
  if (production && demo) throw new Error('DEMO_MODE cannot be enabled in production');
  const config: Config = {
    port: Number(env.PORT || 3001), demo, production,
    demoUserId: env.DEMO_USER_ID?.trim() || undefined,
    demoAccessLevel: (env.DEMO_ACCESS_LEVEL || 'member') as Config['demoAccessLevel'],
    origin: env.APP_ORIGIN || 'http://localhost:5173',
    databaseUrl: env.DATABASE_URL, demoDatabaseUrl: env.DEMO_DATABASE_URL, botToken: env.TELEGRAM_BOT_TOKEN,
    botUsername: env.TELEGRAM_BOT_USERNAME,
    botInternalSecret: env.BOT_INTERNAL_SECRET?.trim() || undefined,
    demoDataFile: env.DEMO_DATA_FILE?.trim() || undefined,
    telegramGroups: [...new Set((env.TELEGRAM_GROUP_IDS || '').split(',').map(s => s.trim()).filter(Boolean))],
    adminTelegramIds: [...new Set((env.TELEGRAM_ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean))],
    membershipTtlMs: Number(env.TELEGRAM_MEMBERSHIP_TTL_SECONDS || 60) * 1000,
    sessionTtlMs: 7 * 24 * 60 * 60 * 1000,
  };
  if (config.demoUserId && !/^[A-Za-z0-9_-]{1,160}$/.test(config.demoUserId)) throw new Error('DEMO_USER_ID must be an internal profile ID');
  if (!['member', 'admin'].includes(config.demoAccessLevel!)) throw new Error('DEMO_ACCESS_LEVEL must be member or admin');
  if (config.telegramGroups.some(id => !/^-[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id)))) throw new Error('TELEGRAM_GROUP_IDS must contain numeric group IDs');
  if (config.adminTelegramIds.some(id => !/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id)))) throw new Error('TELEGRAM_ADMIN_IDS must contain numeric Telegram user IDs');
  config.telegramGroupLevels = parseGroupLevels(env.TELEGRAM_GROUP_LEVELS, config.telegramGroups);
  if (!Number.isInteger(config.membershipTtlMs) || config.membershipTtlMs! % 1000 !== 0 || config.membershipTtlMs! < 15000 || config.membershipTtlMs! > 300000) throw new Error('TELEGRAM_MEMBERSHIP_TTL_SECONDS must be an integer from 15 to 300');
  if (config.botUsername && !/^[A-Za-z0-9_]{5,32}$/.test(config.botUsername)) throw new Error('TELEGRAM_BOT_USERNAME must be a bot username without @');
  if (config.botInternalSecret && !/^[\x21-\x7e]{32,256}$/.test(config.botInternalSecret)) throw new Error('BOT_INTERNAL_SECRET must contain 32 to 256 non-space ASCII characters');
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) throw new Error('PORT must be an integer from 1 to 65535');
  let origin: URL;
  try { origin = new URL(config.origin); } catch { throw new Error('APP_ORIGIN must be an absolute HTTP(S) origin'); }
  if (!['http:', 'https:'].includes(origin.protocol) || origin.origin !== config.origin || origin.username || origin.password) throw new Error('APP_ORIGIN must contain only scheme and host, without path, query or trailing slash');
  if (!demo && !config.databaseUrl) throw new Error('DATABASE_URL is required. For isolated local preview run npm run dev:demo.');
  if (production && (!config.botToken || !config.botUsername || !config.telegramGroups.length)) throw new Error('Telegram bot and membership groups must be configured for production');
  if (production && !config.botInternalSecret) throw new Error('BOT_INTERNAL_SECRET is required for the separate Telegram bot');
  if (production && origin.protocol !== 'https:') throw new Error('APP_ORIGIN must use HTTPS in production');
  return config;
}
