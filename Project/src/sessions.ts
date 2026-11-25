import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { HttpError, notFound } from './errors.js';

export interface SessionRecord {
  userId: string;
  expiresAt: string;
  source?: 'demo' | 'telegram';
  createdAt?: string;
  firstSeenAt?: string;
  lastActiveAt?: string;
  browser?: string;
  os?: string;
  ip?: string;
}

export const activityInterval = 5 * 60_000;
const cooldown = 24 * 60 * 60_000;
const browsers: [RegExp, string][] = [
  [/Edg(?:e|A|iOS)?\//i,'Edge'], [/OP(?:R|iOS)\//i,'Opera'], [/SamsungBrowser\//i,'Samsung Internet'],
  [/YaBrowser\//i,'Яндекс Браузер'], [/(?:Firefox|FxiOS)\//i,'Firefox'], [/; wv\)/i,'Android WebView'],
  [/(?:Chrome|CriOS|Chromium)\//i,'Chrome'], [/Version\/.*Safari\//i,'Safari'],
];
const systems: [RegExp, string][] = [
  [/iPad/i,'iPadOS'], [/(?:iPhone|iPod)/i,'iOS'], [/Android/i,'Android'], [/Windows/i,'Windows'],
  [/CrOS/i,'ChromeOS'], [/Macintosh|Mac OS X/i,'macOS'], [/Linux/i,'Linux'],
];

export function deviceInfo(userAgent = '', address?: string) {
  const agent = userAgent.slice(0, 1024);
  const ip = address?.replace(/^::ffff:(?=\d+\.)/i,'');
  return { browser:browsers.find(([pattern]) => pattern.test(agent))?.[1],
    os:systems.find(([pattern]) => pattern.test(agent))?.[1], ip:ip && isIP(ip) ? ip : undefined };
}

function publicSessionId(key: string) {
  // A list entry cannot be used as a cookie or as the database session key.
  return createHash('sha256').update('klan:session-list:' + key).digest('hex');
}

function activeOwner(sessions: Record<string,SessionRecord>, key: string, userId: string, now: number) {
  const current = sessions[key];
  if (!current || current.userId !== userId || !(Date.parse(current.expiresAt) > now)) {
    throw new HttpError(401, 'UNAUTHORIZED', 'Сессия завершена. Войдите снова.');
  }
  return current;
}

function unlockTime(session: SessionRecord, now: number) {
  const since = Date.parse(session.createdAt ?? session.firstSeenAt ?? '');
  return (Number.isFinite(since) ? since : now) + cooldown;
}

export function sessionList(sessions: Record<string,SessionRecord>, key: string, userId: string, now: number) {
  const current = activeOwner(sessions, key, userId, now);
  const unlock = unlockTime(current, now);
  const items = Object.entries(sessions)
    .filter(([,s]) => s.userId === userId && Date.parse(s.expiresAt) > now)
    .map(([id,s]) => ({ id:publicSessionId(id), current:id === key, browser:s.browser ?? null, os:s.os ?? null,
      ip:s.ip ?? null, createdAt:s.createdAt ?? null, lastActiveAt:s.lastActiveAt ?? null }))
    .sort((a,b) => Number(b.current) - Number(a.current) || (b.lastActiveAt ?? '').localeCompare(a.lastActiveAt ?? ''));
  return { items, serverTime:new Date(now).toISOString(), revokeOthersAfter:new Date(unlock).toISOString() };
}

export function revokeSessions(sessions: Record<string,SessionRecord>, key: string, userId: string, target: string, now: number) {
  const current = activeOwner(sessions, key, userId, now);
  if (target !== publicSessionId(key) && now < unlockTime(current, now)) {
    throw new HttpError(403, 'SESSION_TOO_NEW', 'Завершать другие сессии можно через 24 часа после входа.');
  }
  const revoked: string[] = [];
  for (const [id,session] of Object.entries(sessions)) {
    if (session.userId !== userId || !(Date.parse(session.expiresAt) > now)) continue;
    if (target === 'others' ? id !== key : publicSessionId(id) === target) {
      delete sessions[id];
      revoked.push(id);
    }
  }
  if (target !== 'others' && !revoked.length) throw notFound();
  return revoked;
}
