import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { Router, type RequestHandler, type Response } from 'express';
import type { User } from './shared/contracts.js';
import type { Config } from './config.js';
import type { DatabaseState, Repository } from './repository.js';
import { HttpError } from './errors.js';
import { hydrateUser } from './domain.js';
import { accessForLevel, resolveTelegramAccess } from './access.js';
import type { AccessSummary } from './shared/access.js';
import { allocateUserPublicId } from './user-ids.js';
import type { TelegramMethod } from './bot-channel.js';

declare global {
  namespace Express {
    interface Request { user?: User }
  }
}

type TelegramUser = { id: number; is_bot?: boolean; first_name: string; last_name?: string; username?: string };
type TelegramMessage = { from?: TelegramUser; chat: { id: number; type: string }; text?: string };
type TelegramCallback = {
  id: string; from: TelegramUser; data?: string;
  message?: { message_id: number; chat: TelegramMessage['chat'] };
};
export type TelegramUpdate = { update_id: number; message?: TelegramMessage; callback_query?: TelegramCallback };
type TelegramMember = { status: string; is_member?: boolean };
const authLifetimeMs = 5 * 60 * 1000;
const moscowTime = new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});
function formatTime(timestamp: string | number): string {
  return `${moscowTime.format(new Date(timestamp))} МСК`;
}
export interface AuthDependencies {
  now?: () => number;
  botUsername?: () => string | undefined;
  telegramRequest?: <T>(method: TelegramMethod, payload: object) => Promise<T>;
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

  function requestDetails(request: DatabaseState['authRequests'][string]): string {
    const requestedAt = request.requestedAt ?? Date.parse(request.expiresAt) - authLifetimeMs;
    return `Сайт: ${request.origin ?? config.origin}\nВремя запроса: ${formatTime(requestedAt)}`;
  }

  async function telegram<T>(method: TelegramMethod, payload: object): Promise<T> {
    try {
      if (!dependencies.telegramRequest) throw new Error('Bot unavailable');
      return await dependencies.telegramRequest<T>(method, payload);
    } catch {
      throw failure(503, 'TELEGRAM_UNAVAILABLE', 'Telegram временно недоступен. Попробуйте ещё раз.');
    }
  }

  async function telegramAccess(telegramId: string, fresh = false): Promise<AccessSummary | undefined> {
    if (!config.botInternalSecret) return undefined;
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

  async function userFromCookie(cookie?: string, withProfile = true): Promise<User | undefined> {
    const token = readCookie(cookie, sessionCookie);
    if (!token || !/^[a-f0-9]{64}$/.test(token)) return undefined;
    const sessionKey = hashToken(token);
    const value = repo.readSession ? await repo.readSession(sessionKey, now(), withProfile) : await repo.read((state) => {
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
    if (value.user.role !== role || !isDeepStrictEqual(value.user.access, access)) return synchronizeAccess(value.user.id, access);
    return { ...value.user, role, access };
  }

  const requireAuth: RequestHandler = async (req, res, next) => {
    try {
      const user = await userFromCookie(req.headers.cookie, !['GET', 'HEAD'].includes(req.method) || req.path === '/me');
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

  const currentBotUsername = () => config.botInternalSecret && (!requireMembership || config.telegramGroups.length > 0)
    ? dependencies.botUsername?.() : undefined;
  router.get('/config', (_req, res) => {
    res.json({ data: { demo: config.demo && !config.production, botUsername: currentBotUsername() ?? null } });
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
      if (!config.botInternalSecret || (requireMembership && config.telegramGroups.length === 0)) {
        throw failure(503, 'TELEGRAM_NOT_CONFIGURED', 'Для входа администратор должен настроить авторизацию через Telegram.');
      }
      const botUsername = currentBotUsername();
      if (!botUsername) throw failure(503, 'TELEGRAM_UNAVAILABLE', 'Бот Telegram временно недоступен. Попробуйте ещё раз.');
      const id = randomBytes(24).toString('hex');
      const displayCode = String(randomInt(1_000_000)).padStart(6, '0');
      const browserToken = randomBytes(32).toString('hex');
      const created = now();
      const expiresAt = new Date(created + authLifetimeMs).toISOString();
      await repo.write((state) => {
        for (const [key, request] of Object.entries(state.authRequests)) {
          if (Date.parse(request.expiresAt) <= now()) delete state.authRequests[key];
        }
        state.authRequests[id] = {
          browserHash: hashToken(browserToken), expiresAt, status: 'pending', displayCode,
          origin: config.origin, requestedAt: new Date(created).toISOString(),
        };
      });
      res.cookie(browserCookie, browserToken, { ...cookieOptions, maxAge: authLifetimeMs });
      res.json({ data: { id, botUrl: `https://t.me/${botUsername}?start=${id}`, expiresAt, displayCode } });
    } catch (error) { next(error); }
  });

  router.get('/telegram/status/:id', async (req, res, next) => {
    try {
      const id = String(req.params.id);
      const browserToken = readCookie(req.headers.cookie, browserCookie);
      if (!/^[a-f0-9]{48}$/.test(id) || !browserToken) {
        throw failure(400, 'INVALID_LOGIN', 'Откройте вход в этом браузере заново.');
      }
      const browserHash = hashToken(browserToken);
      function status(request?: DatabaseState['authRequests'][string]) {
        if (!request || Date.parse(request.expiresAt) <= now()) return 'expired' as const;
        if (!equalHash(request.browserHash, browserHash)) {
          throw failure(403, 'BROWSER_MISMATCH', 'Запрос входа принадлежит другому браузеру.');
        }
        if (request.status === 'denied' || request.status === 'rejected') return request.status;
        if (request.status !== 'approved' || !request.userId) return 'pending' as const;
        return 'approved' as const;
      }
      if (repo.authRequest) {
        const current = status(await repo.authRequest(id));
        if (current !== 'approved') {
          res.json({ data: { status: current } });
          return;
        }
      }
      const approvedUser = await repo.write((state) => {
        const request = state.authRequests[id];
        const current = status(request);
        if (current === 'expired') delete state.authRequests[id];
        if (current !== 'approved') return current;
        const user = state.users.find((candidate) => candidate.id === request!.userId);
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

  router.post('/telegram/cancel/:id', async (req, res, next) => {
    try {
      const id = String(req.params.id);
      const browserToken = readCookie(req.headers.cookie, browserCookie);
      if (!/^[a-f0-9]{48}$/.test(id) || !browserToken) {
        throw failure(400, 'INVALID_LOGIN', 'Откройте вход в этом браузере заново.');
      }
      await repo.write(state => {
        const request = state.authRequests[id];
        if (request && equalHash(request.browserHash, hashToken(browserToken))) delete state.authRequests[id];
      });
      res.sendStatus(204);
    } catch (error) { next(error); }
  });

  async function handleStart(message: TelegramMessage): Promise<void> {
    const telegramUser = message.from;
    if (!telegramUser || !Number.isSafeInteger(telegramUser.id) || telegramUser.id <= 0 || telegramUser.is_bot
      || message.chat.type !== 'private' || message.chat.id !== telegramUser.id) return;
    const match = message.text?.match(/^\/start(?:@[A-Za-z0-9_]+)?\s+([a-f0-9]{48})\s*$/);
    if (!match) return;
    const requestId = match[1]!;
    const telegramId = String(telegramUser.id);
    const prompt = await repo.write(state => {
      const request = state.authRequests[requestId];
      if (!request?.displayCode || request.status !== 'pending' || Date.parse(request.expiresAt) <= now()) return 'closed' as const;
      if (request.telegramId && request.telegramId !== telegramId) return 'other' as const;
      if (request.promptMessageId) return 'sent' as const;
      request.telegramId = telegramId;
      return { code: request.displayCode, details: requestDetails(request) };
    });
    if (prompt === 'closed') {
      await telegram('sendMessage', { chat_id: message.chat.id, text: 'Ссылка входа истекла или уже использована. Вернитесь на сайт KLAN и начните вход заново.' });
      return;
    }
    if (prompt === 'other' || prompt === 'sent') {
      await telegram('sendMessage', { chat_id: message.chat.id, text: prompt === 'other'
        ? 'Запрос открыт другим аккаунтом Telegram. Создайте новую ссылку на сайте.'
        : 'Запрос уже открыт. Используйте кнопки в первом сообщении.' });
      return;
    }
    const receipt = await telegram<{ message_id: number }>('sendMessage', {
      chat_id: message.chat.id,
      text: `Запрос на вход в Клан.\n${prompt.details}\nКод подтверждения: ${prompt.code}\n\nСверьте код с кодом на сайте. Подтверждайте только свой запрос. Если вы не начинали вход, нажмите «Отклонить». Никому не пересылайте ссылку на вход.`,
      reply_markup: { inline_keyboard: [[
        { text: 'Авторизоваться', callback_data: `ok:${requestId}` },
        { text: 'Отклонить', callback_data: `no:${requestId}` },
      ]] },
    });
    if (!receipt || !Number.isSafeInteger(receipt.message_id) || receipt.message_id <= 0) {
      throw failure(503, 'TELEGRAM_UNAVAILABLE', 'Не удалось получить подтверждение от Telegram.');
    }
    await repo.write(state => {
      const request = state.authRequests[requestId];
      if (request?.status === 'pending' && request.telegramId === telegramId) request.promptMessageId ??= receipt.message_id;
    });
  }

  async function handleCallback(query: TelegramCallback): Promise<void> {
    const match = /^(ok|no):([a-f0-9]{48})$/.exec(query.data ?? '');
    const message = query.message;
    const telegramUser = query.from;
    const telegramId = String(telegramUser.id);
    const requestId = match?.[2];
    const request = requestId ? await repo.read(state => state.authRequests[requestId]) : undefined;
    const bound = request?.telegramId === telegramId && request.promptMessageId === message?.message_id;
    if (!requestId || !message || telegramUser.is_bot || message.chat.type !== 'private' || message.chat.id !== telegramUser.id || !bound) {
      await telegram('answerCallbackQuery', { callback_query_id: query.id, text: 'Запрос закрыт или недействителен.' }).catch(() => undefined);
      return;
    }
    const wantsApproval = match?.[1] === 'ok';
    await telegram('answerCallbackQuery', { callback_query_id: query.id }).catch(() => undefined);
    const access = wantsApproval && request.status === 'pending' && Date.parse(request.expiresAt) > now()
      ? await telegramAccess(telegramId, true) : undefined;
    const outcome = await repo.write((state) => {
      const current = state.authRequests[requestId];
      const decisionTime = now();
      if (!current || current.telegramId !== telegramId || current.promptMessageId !== message.message_id
        || Date.parse(current.expiresAt) <= decisionTime) return { status: 'expired' } as const;
      if (current.status !== 'pending') return { status: current.status, decidedAt: current.decidedAt };
      current.decidedAt = new Date(decisionTime).toISOString();
      if (!access) {
        current.status = wantsApproval ? 'denied' : 'rejected';
        return { status: current.status, decidedAt: current.decidedAt };
      }
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
      return { status: current.status, decidedAt: current.decidedAt };
    });
    const resultText = {
      approved: 'Вход в Клан подтверждён. Вернитесь в браузер, в котором начали вход.',
      rejected: 'Запрос на вход в Клан отклонён.',
      denied: 'Не удалось подтвердить доступ к Клану. Если ошибка повторяется, обратитесь к администратору.',
      expired: 'Запрос закрыт. Вернитесь на сайт и начните вход заново.',
    };
    const lines = [resultText[outcome.status], requestDetails(request)];
    if (outcome.decidedAt) {
      const label = outcome.status === 'approved' ? 'Время подтверждения' : 'Время отказа';
      lines.push(`${label}: ${formatTime(outcome.decidedAt)}`);
    }
    const text = lines.join('\n');
    await telegram('editMessageText', { chat_id: message.chat.id, message_id: message.message_id, text }).catch(async () => {
      if (request.status === 'pending') await telegram('sendMessage', { chat_id: message.chat.id, text });
    });
  }

  async function handleTelegramUpdate(update: TelegramUpdate): Promise<void> {
    if (update.message) await handleStart(update.message);
    if (update.callback_query) await handleCallback(update.callback_query);
  }

  return { router, requireAuth, requireAdmin, userFromCookie, handleTelegramUpdate };
}
