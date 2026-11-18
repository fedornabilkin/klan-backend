import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { Router, type RequestHandler, type Response } from 'express';
import type { User } from './shared/contracts.js';
import type { Config } from './config.js';
import type { Repository } from './repository.js';
import { HttpError } from './errors.js';
import { hydrateUser } from './domain.js';
import { accessForLevel, resolveTelegramAccess } from './access.js';
import type { AccessSummary } from './shared/access.js';
import { allocateUserPublicId } from './user-ids.js';

declare global {
  namespace Express {
    interface Request { user?: User }
  }
}

type TelegramUser = { id: number; is_bot?: boolean; first_name: string; last_name?: string; username?: string };
type TelegramMessage = { from?: TelegramUser; chat: { id: number; type: string }; text?: string };
export type TelegramUpdate = { update_id: number; message?: TelegramMessage };
type TelegramMember = { status: string; is_member?: boolean };
type TelegramEnvelope<T> = { ok: boolean; result?: T };
const authLifetimeMs = 5 * 60 * 1000;
export interface AuthDependencies {
  now?: () => number;
  telegramRequest?: <T>(method: string, payload: object, signal?: AbortSignal) => Promise<T>;
}

export function hashToken(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function isTelegramMember(member: TelegramMember): boolean {
  return ['creator', 'administrator', 'member'].includes(member.status)
    || (member.status === 'restricted' && member.is_member === true);
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const piece of header.split(';')) {
    const [key, ...rest] = piece.trim().split('=');
    if (key !== name) continue;
    try { return decodeURIComponent(rest.join('=')); } catch { return undefined; }
  }
  return undefined;
}

function equalHash(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(left) || !/^[a-f0-9]{64}$/.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function failure(status: number, code: string, message: string): HttpError {
  return new HttpError(status, code, message);
}

/** Server-owned sessions and one-use browser-bound Telegram authorizations. */
export function createAuth(
  repo: Repository,
  config: Config,
  onEvent?: (user: User, action: string) => Promise<void>,
  dependencies: AuthDependencies = {},
) {
  const now = dependencies.now ?? Date.now;
  const router = Router();
  router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  const sessionCookie = config.production ? '__Host-klan_session' : 'klan_session';
  const browserCookie = config.production ? '__Host-klan_auth' : 'klan_auth';
  const cookieOptions = { httpOnly: true, secure: config.production, sameSite: 'lax' as const, path: '/' };
  const membershipChecks = new Map<string, { expiresAt: number; access: AccessSummary | undefined }>();
  const pendingChecks = new Map<string, Promise<AccessSummary | undefined>>();
  const requireMembership = config.telegramGroupMembershipRequired !== false;

  async function telegram<T>(method: string, payload: object, signal?: AbortSignal): Promise<T> {
    if (!config.botToken) throw failure(503, 'TELEGRAM_NOT_CONFIGURED', 'Вход через Telegram пока не настроен.');
    // Never include Telegram's URL or request payload in an error: the URL contains the bot token.
    try {
      if (dependencies.telegramRequest) return await dependencies.telegramRequest<T>(method, payload, signal);
      const response = await fetch(`https://api.telegram.org/bot${config.botToken}/${method}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(35_000)]) : AbortSignal.timeout(12_000),
      });
      const body = await response.json() as TelegramEnvelope<T>;
      if (!response.ok || !body.ok || body.result === undefined) throw new Error('Unavailable');
      return body.result;
    } catch {
      throw failure(503, 'TELEGRAM_UNAVAILABLE', 'Telegram временно недоступен. Попробуйте ещё раз.');
    }
  }

  async function telegramAccess(telegramId: string, fresh = false): Promise<AccessSummary | undefined> {
    if (!config.botToken) return undefined;
    if (!requireMembership) {
      return accessForLevel(config.adminTelegramIds.includes(telegramId) ? 'admin' : 'member', 'telegram');
    }
    if (config.telegramGroups.length === 0) return undefined;
    const known = membershipChecks.get(telegramId);
    if (!fresh && known && known.expiresAt > now()) return known.access;
    const pending = pendingChecks.get(telegramId);
    if (pending) return pending;
    const promise = (async () => {
      // A Telegram outage fails closed instead of extending an old permission indefinitely.
      const results = await Promise.all(config.telegramGroups.map(async (chat_id) => {
        try {
          const member = await telegram<TelegramMember>('getChatMember', { chat_id, user_id: Number(telegramId) });
          return isTelegramMember(member) ? chat_id : undefined;
        } catch { return undefined; }
      }));
      const matchedGroups = results.filter((id): id is string => !!id);
      const access = resolveTelegramAccess(matchedGroups, config.telegramGroupLevels ?? {}, config.adminTelegramIds.includes(telegramId));
      membershipChecks.set(telegramId, { expiresAt: now() + (access ? config.membershipTtlMs ?? 60_000 : 15_000), access });
      return access;
    })();
    pendingChecks.set(telegramId, promise);
    try { return await promise; } finally { pendingChecks.delete(telegramId); }
  }

  async function synchronizeAccess(userId: string, access: AccessSummary): Promise<User | undefined> {
    return repo.write(state => {
      const user = state.users.find(candidate => candidate.id === userId);
      if (!user) return undefined;
      user.role = access.level === 'admin' ? 'admin' : 'member';
      user.access = access;
      return hydrateUser(state, user);
    });
  }

  function demoPrincipal(user: User): User {
    const level = config.demoAccessLevel ?? 'member';
    // The preview role belongs to this session, never to the persisted profile.
    return { ...user, role: level, access: accessForLevel(level, 'demo') };
  }

  async function userFromCookie(cookie?: string): Promise<User | undefined> {
    const token = readCookie(cookie, sessionCookie);
    if (!token || !/^[a-f0-9]{64}$/.test(token)) return undefined;
    const sessionKey = hashToken(token);
    const value = await repo.read((state) => {
      const session = state.sessions[sessionKey];
      if (!session || Date.parse(session.expiresAt) <= now()) return undefined;
      const user = state.users.find((candidate) => candidate.id === session.userId);
      if (!user) return undefined;
      const telegramId = Object.entries(state.telegramUsers).find(([, id]) => id === user.id)?.[0];
      return { user: hydrateUser(state, user), telegramId, source: session.source };
    });
    if (!value) return undefined;
    if (value.source === 'demo') return config.demo && !config.production && value.user.id === config.demoUserId
      ? demoPrincipal(value.user) : undefined;
    if (!value.telegramId) return undefined;
    const access = await telegramAccess(value.telegramId);
    if (!access) {
      await repo.write((state) => { delete state.sessions[sessionKey]; });
      return undefined;
    }
    const role = access.level === 'admin' ? 'admin' : 'member';
    if (value.user.role !== role || JSON.stringify(value.user.access) !== JSON.stringify(access)) return synchronizeAccess(value.user.id, access);
    return { ...value.user, role, access };
  }

  const requireAuth: RequestHandler = async (req, res, next) => {
    try {
      const user = await userFromCookie(req.headers.cookie);
      if (!user) {
        res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Войдите через Telegram, чтобы продолжить.' } });
        return;
      }
      req.user = user;
      next();
    } catch (error) { next(error); }
  };
  const requireAdmin: RequestHandler = (req, res, next) => {
    if (req.user?.role !== 'admin') {
      res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Доступно только администраторам.' } });
      return;
    }
    next();
  };

  async function recordEvent(user: User, action: string): Promise<void> {
    try { await onEvent?.(user, action); }
    catch { console.warn('Authentication activity could not be recorded.'); }
  }

  async function issueSession(res: Response, user: User, previousCookie?: string, source: 'demo' | 'telegram' = 'telegram'): Promise<void> {
    const token = randomBytes(32).toString('hex');
    const previous = readCookie(previousCookie, sessionCookie);
    await repo.write((state) => {
      const timestamp = now();
      for (const [key, session] of Object.entries(state.sessions)) {
        if (Date.parse(session.expiresAt) <= timestamp) delete state.sessions[key];
      }
      if (previous) delete state.sessions[hashToken(previous)];
      state.sessions[hashToken(token)] = { userId: user.id, expiresAt: new Date(timestamp + config.sessionTtlMs).toISOString(), source };
    });
    res.cookie(sessionCookie, token, { ...cookieOptions, maxAge: config.sessionTtlMs });
    await recordEvent(user, 'вошёл в сообщество');
  }

  router.get('/config', (_req, res) => {
    res.json({ data: { demo: config.demo && !config.production, botUsername: config.botUsername ?? null } });
  });
  router.get('/me', requireAuth, (req, res) => res.json({ data: req.user }));

  router.post('/demo', async (req, res, next) => {
    try {
      if (!config.demo || config.production) throw failure(404, 'NOT_FOUND', 'Демонстрационный вход отключён.');
      if (!config.demoUserId) throw failure(503, 'DEMO_USER_NOT_CONFIGURED', 'Для демонстрационного входа нужно задать DEMO_USER_ID.');
      const user = await repo.read((state) => {
        const candidate = state.users.find((value) => value.id === config.demoUserId);
        return candidate ? demoPrincipal(hydrateUser(state, candidate)) : undefined;
      });
      if (!user) throw failure(503, 'DEMO_USER_NOT_FOUND', 'Профиль для демонстрационного входа не найден. Проверьте DEMO_USER_ID.');
      await issueSession(res, user, req.headers.cookie, 'demo');
      res.json({ data: user });
    } catch (error) { next(error); }
  });

  router.post('/logout', requireAuth, async (req, res, next) => {
    try {
      const token = readCookie(req.headers.cookie, sessionCookie);
      if (token) await repo.write((state) => { delete state.sessions[hashToken(token)]; });
      res.clearCookie(sessionCookie, cookieOptions);
      await recordEvent(req.user!, 'вышел из сообщества');
      res.json({ data: { success: true } });
    } catch (error) { next(error); }
  });

  router.post('/telegram/start', async (_req, res, next) => {
    try {
      if (!config.botToken || !config.botUsername || (requireMembership && config.telegramGroups.length === 0)) {
        throw failure(503, 'TELEGRAM_NOT_CONFIGURED', 'Для входа администратор должен настроить авторизацию через Telegram.');
      }
      const id = randomBytes(24).toString('hex');
      const browserToken = randomBytes(32).toString('hex');
      const expiresAt = new Date(now() + authLifetimeMs).toISOString();
      await repo.write((state) => {
        for (const [key, request] of Object.entries(state.authRequests)) {
          if (Date.parse(request.expiresAt) <= now()) delete state.authRequests[key];
        }
        state.authRequests[id] = { browserHash: hashToken(browserToken), expiresAt, status: 'pending' };
      });
      res.cookie(browserCookie, browserToken, { ...cookieOptions, maxAge: authLifetimeMs });
      res.json({ data: { id, botUrl: `https://t.me/${config.botUsername}?start=${id}`, expiresAt } });
    } catch (error) { next(error); }
  });

  router.get('/telegram/status/:id', async (req, res, next) => {
    try {
      const id = String(req.params.id);
      const browserToken = readCookie(req.headers.cookie, browserCookie);
      if (!/^[a-f0-9]{48}$/.test(id) || !browserToken) {
        throw failure(400, 'INVALID_LOGIN', 'Откройте вход в этом браузере заново.');
      }
      const approvedUser = await repo.write((state) => {
        const request = state.authRequests[id];
        if (!request || Date.parse(request.expiresAt) <= now()) {
          delete state.authRequests[id];
          return 'expired' as const;
        }
        if (!equalHash(request.browserHash, hashToken(browserToken))) {
          throw failure(403, 'BROWSER_MISMATCH', 'Запрос входа принадлежит другому браузеру.');
        }
        if (request.status !== 'approved' || !request.userId) return 'pending' as const;
        const user = state.users.find((candidate) => candidate.id === request.userId);
        delete state.authRequests[id]; // Atomic consume: concurrent polling cannot replay approval.
        if (!user) return 'expired' as const;
        return hydrateUser(state, user);
      });
      if (typeof approvedUser === 'string') {
        res.json({ data: { status: approvedUser } });
        return;
      }
      // Recompute access before issuing a session in case group membership changed.
      const telegramId = await repo.read(state => Object.entries(state.telegramUsers).find(([, userId]) => userId === approvedUser.id)?.[0]);
      const access = telegramId ? await telegramAccess(telegramId, true) : undefined;
      const user = access ? await synchronizeAccess(approvedUser.id, access) : undefined;
      if (!user) {
        res.clearCookie(browserCookie, cookieOptions);
        res.json({ data: { status: 'denied' } });
        return;
      }
      await issueSession(res, user, req.headers.cookie);
      res.clearCookie(browserCookie, cookieOptions);
      res.json({ data: { status: 'approved', user } });
    } catch (error) { next(error); }
  });

  async function handleStart(message: TelegramMessage): Promise<void> {
    const telegramUser = message.from;
    if (!telegramUser || !Number.isSafeInteger(telegramUser.id) || telegramUser.id <= 0 || telegramUser.is_bot || message.chat.type !== 'private') return;
    const match = message.text?.match(/^\/start(?:@[A-Za-z0-9_]+)?\s+([a-f0-9]{48})\s*$/);
    if (!match) return;
    const requestId = match[1]!;
    const request = await repo.read((state) => state.authRequests[requestId]);
    if (!request || request.status !== 'pending' || Date.parse(request.expiresAt) <= now()) {
      await telegram('sendMessage', { chat_id: message.chat.id, text: 'Ссылка входа истекла или уже использована. Вернитесь на сайт KLAN и начните вход заново.' });
      return;
    }
    const telegramId = String(telegramUser.id);
    const access = await telegramAccess(telegramId, true);
    if (!access) {
      await telegram('sendMessage', { chat_id: message.chat.id, text: 'Вход не подтверждён. Доступ открыт только участникам группы сообщества. При ошибке обратитесь к администратору.' });
      return;
    }
    const approved = await repo.write((state) => {
      const current = state.authRequests[requestId];
      if (!current || current.status !== 'pending' || Date.parse(current.expiresAt) <= now()) return false;
      let user = state.users.find((candidate) => candidate.id === state.telegramUsers[telegramId]);
      const role = access.level === 'admin' ? 'admin' as const : 'member' as const;
      if (!user) {
        const name = [telegramUser.first_name, telegramUser.last_name].filter(Boolean).join(' ').slice(0, 120);
        user = {
          id: randomUUID(), publicId: allocateUserPublicId(state), name, username: telegramUser.username, role, access, bio: '',
          location: { city: '', country: '', lat: null, lng: null }, tags: [],
          initials: name.split(/\s+/).map((part) => part[0]).slice(0, 2).join('').toUpperCase(),
          color: '#f97316', facts: [], interests: [], achievements: [],
          stats: { events: 0, challenges: 0, books: 0 }, joinedAt: new Date(now()).toISOString(),
        };
        state.users.push(user);
        state.telegramUsers[telegramId] = user.id;
      } else {
        user.role = role;
        user.access = access;
        user.username = telegramUser.username;
      }
      current.status = 'approved';
      current.userId = user.id;
      return true;
    });
    await telegram('sendMessage', {
      chat_id: message.chat.id,
      text: approved ? 'Вход в KLAN подтверждён. Вернитесь в браузер, из которого начали вход. Никому не пересылайте ссылки для авторизации.' : 'Ссылка уже использована. Начните вход на сайте заново.',
    });
  }

  async function handleTelegramUpdate(update: TelegramUpdate): Promise<void> {
    if (update.message) await handleStart(update.message);
  }

  return { router, requireAuth, requireAdmin, userFromCookie, handleTelegramUpdate };
}
