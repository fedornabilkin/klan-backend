import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { json, Router, type Request, type RequestHandler, type Response } from 'express';
import type { Activity, User } from './shared/contracts.js';
import type { Config } from './config.js';
import type { DatabaseState, Repository, SessionPrincipal } from './repository.js';
import { deviceInfo, revokeSessions, sessionIsLive, sessionList } from './sessions.js';
import { sessionActivity } from './session-activity.js';
import { HttpError } from './errors.js';
import { addActivity, hydrateUser, publicActivity } from './domain.js';
import { accessForLevel, resolveTelegramAccess } from './access.js';
import type { AccessSummary } from './shared/access.js';
import { bindDeploymentAdmin, isDeploymentAdmin } from './deployment-admins.js';
import { allocateUserPublicId } from './user-ids.js';
import type { TelegramMethod } from './bot-channel.js';
import type { SiteAccess } from './access-settings.js';

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
  onEvent?: (activity: Activity) => void,
  dependencies: AuthDependencies = {},
  onSessionsRevoked?: (keys: string[]) => void,
) {
  const now = dependencies.now ?? Date.now;
  const activity = sessionActivity(repo, config.sessionTtlMs, now);
  const router = Router();
  router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  const sessionCookie = config.production ? '__Host-klan_session' : 'klan_session';
  const browserCookie = config.production ? '__Host-klan_auth' : 'klan_auth';
  const cookieOptions = { httpOnly: true, secure: config.production, sameSite: 'lax' as const, path: '/' };
  const membershipChecks = new Map<string, { expiresAt: number; access: AccessSummary | undefined }>();
  const pendingChecks = new Map<string, Promise<AccessSummary | undefined>>();
  let cachedPolicy: string | undefined;

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

  async function telegramAccess(telegramId: string, userId: string | undefined, policy: SiteAccess | undefined, fresh = false): Promise<AccessSummary | undefined> {
    if (!config.botInternalSecret) return undefined;
    if (userId && policy?.adminIds.includes(userId)) return accessForLevel('admin', 'telegram');
    const groups = policy ? policy.groups.map(group => group.id) : config.telegramGroups;
    if (!(policy?.membersOnly ?? config.telegramGroupMembershipRequired !== false)) {
      return accessForLevel(config.adminTelegramIds.includes(telegramId) ? 'admin' : 'member', 'telegram');
    }
    if (!groups.length) return undefined;
    if (cachedPolicy !== policy?.revision) {
      membershipChecks.clear();
      cachedPolicy = policy?.revision;
    }
    const key = (policy?.revision ?? 'env') + ':' + telegramId;
    const known = membershipChecks.get(telegramId);
    if (!fresh && known && known.expiresAt > now()) return known.access;
    const pending = pendingChecks.get(key);
    if (pending) return pending;
    const promise = (async () => {
      // A Telegram outage fails closed instead of extending an old permission indefinitely.
      const results = await Promise.all(groups.map(async (chat_id) => {
        try {
          const member = await telegram<TelegramMember>('getChatMember', { chat_id, user_id: Number(telegramId) });
          return isTelegramMember(member) ? chat_id : undefined;
        } catch { return undefined; }
      }));
      const matchedGroups = results.filter((id): id is string => !!id);
      const access = resolveTelegramAccess(matchedGroups, config.telegramGroupLevels ?? {}, config.adminTelegramIds.includes(telegramId));
      if (policy?.revision === cachedPolicy) membershipChecks.set(telegramId, { expiresAt: now() + (access ? config.membershipTtlMs ?? 60_000 : 15_000), access });
      return access;
    })();
    pendingChecks.set(key, promise);
    try { return await promise; } finally { pendingChecks.delete(key); }
  }

  function checkPolicy(state: DatabaseState, revision?: string) {
    if (state.accessSettings.site?.revision !== revision) throw failure(409, 'SETTINGS_CHANGED', 'Правила доступа изменились. Повторите запрос.');
  }

  async function synchronizeAccess(userId: string, access: AccessSummary, revision?: string): Promise<User | undefined> {
    return repo.write(state => {
      checkPolicy(state, revision);
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

  function cookieKey(cookie?: string) {
    const token = readCookie(cookie, sessionCookie);
    return token && /^[a-f0-9]{64}$/.test(token) ? hashToken(token) : undefined;
  }

  async function userFromCookie(cookie?: string, withProfile = true, recordActivity = false): Promise<User | undefined> {
    const sessionKey = cookieKey(cookie);
    if (!sessionKey) return undefined;
    await activity.flushDue();
    const value = repo.readSession ? await repo.readSession(sessionKey, now(), withProfile) : await repo.read((state) => {
      const session = state.sessions[sessionKey];
      if (!session || !sessionIsLive(session, now())) return undefined;
      const user = state.users.find((candidate) => candidate.id === session.userId);
      if (!user) return undefined;
      const telegramId = Object.entries(state.telegramUsers).find(([, id]) => id === user.id)?.[0];
      return { user: hydrateUser(state, user), expiresAt:Date.parse(session.expiresAt), lastActiveAt:session.lastActiveAt, telegramId, policy:state.accessSettings.site, managedAdmin:isDeploymentAdmin(telegramId,state.managedAdmins), source: session.source };
    });
    if (!value) return undefined;
    const at = now();
    if (value.expiresAt <= at) return undefined;
    const user = await resolvePrincipal(value, sessionKey);
    if (user && recordActivity) await activity.record(sessionKey, at, value.lastActiveAt, value.expiresAt);
    return user;
  }

  async function resolvePrincipal(value: SessionPrincipal, sessionKey: string): Promise<User | undefined> {
    if (value.source === 'demo') return config.demo && !config.production && value.user.id === config.demoUserId
      ? demoPrincipal(value.user) : undefined;
    if (!value.telegramId) return undefined;
    const granted = await telegramAccess(value.telegramId, value.user.id, value.policy);
    const access = granted && value.managedAdmin ? accessForLevel('admin','telegram') : granted;
    if (!access) {
      await repo.write((state) => { checkPolicy(state, value.policy?.revision); delete state.sessions[sessionKey]; });
      return undefined;
    }
    const role = access.level === 'admin' ? 'admin' : 'member';
    if (value.user.role !== role || !isDeepStrictEqual(value.user.access, access)) return synchronizeAccess(value.user.id, access, value.policy?.revision);
    return { ...value.user, role, access };
  }

  const requireAuth: RequestHandler = async (req, res, next) => {
    try {
      const user = await userFromCookie(req.headers.cookie, !['GET', 'HEAD'].includes(req.method) || req.path === '/me', true);
      if (!user) {
        res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Войдите через Telegram, чтобы продолжить.' } });
        return;
      }
      req.user = user;
      if (req.path !== '/logout') {
        res.cookie(sessionCookie, readCookie(req.headers.cookie, sessionCookie)!, { ...cookieOptions, maxAge: config.sessionTtlMs });
      }
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

  function publishActivity(activity: Activity) {
    try { onEvent?.(activity); }
    catch { console.warn('Authentication activity could not be broadcast.'); }
  }

  async function issueSession(req: Request, res: Response, user: User, source: 'demo' | 'telegram' = 'telegram', revision?: string): Promise<void> {
    const token = randomBytes(32).toString('hex');
    const previous = cookieKey(req.headers.cookie);
    const device = deviceInfo(req.get('user-agent'), req.ip);
    await activity.flushDue();
    const loginActivity = await repo.write((state) => {
      if (source === 'telegram') checkPolicy(state, revision);
      const timestamp = now();
      for (const [key, session] of Object.entries(state.sessions)) {
        if (!sessionIsLive(session, timestamp)) delete state.sessions[key];
      }
      if (previous) delete state.sessions[previous];
      const createdAt = new Date(timestamp).toISOString();
      state.sessions[hashToken(token)] = { userId: user.id, expiresAt: new Date(timestamp + config.sessionTtlMs).toISOString(), source, createdAt, lastActiveAt:createdAt, ...device };
      return publicActivity(state, addActivity(state, user, 'вошёл в сообщество'));
    });
    res.cookie(sessionCookie, token, { ...cookieOptions, maxAge: config.sessionTtlMs });
    publishActivity(loginActivity);
  }

  const currentBotUsername = () => config.botInternalSecret
    ? dependencies.botUsername?.() : undefined;
  router.get('/config', (_req, res) => {
    res.json({ data: { demo: config.demo && !config.production, botUsername: currentBotUsername() ?? null } });
  });
  router.get('/me', requireAuth, (req, res) => res.json({ data: req.user }));
  router.get('/sessions', requireAuth, async (req, res) => {
    const key = cookieKey(req.headers.cookie)!;
    const userId = req.user!.id;
    const at = now();
    const data = repo.userSessions
      ? sessionList(await repo.userSessions(userId,at), key, userId, at)
      : await repo.read(state => sessionList(state.sessions, key, userId, at));
    res.json({data});
  });
  router.delete('/sessions/:target', requireAuth, async (req, res) => {
    const key = cookieKey(req.headers.cookie)!;
    const target = String(req.params.target);
    if (target !== 'others' && !/^[a-f0-9]{64}$/.test(target)) throw failure(404, 'NOT_FOUND', 'Сессия не найдена.');
    const revoked = await repo.write(state => revokeSessions(state.sessions, key, req.user!.id, target, now()));
    if (revoked.includes(key)) {
      res.removeHeader('Set-Cookie');
      res.clearCookie(sessionCookie, cookieOptions);
    }
    onSessionsRevoked?.(revoked);
    res.sendStatus(204);
  });

  const loginBody = json({ limit: '4kb', inflate: false });
  router.post('/demo', loginBody, async (req, res, next) => {
    try {
      if (!config.demo || config.production) throw failure(404, 'NOT_FOUND', 'Демонстрационный вход отключён.');
      if (!config.demoUserId) throw failure(503, 'DEMO_USER_NOT_CONFIGURED', 'Для демонстрационного входа нужно задать DEMO_USER_ID.');
      const user = await repo.read((state) => {
        const candidate = state.users.find((value) => value.id === config.demoUserId);
        return candidate ? demoPrincipal(hydrateUser(state, candidate)) : undefined;
      });
      if (!user) throw failure(503, 'DEMO_USER_NOT_FOUND', 'Профиль для демонстрационного входа не найден. Проверьте DEMO_USER_ID.');
      await issueSession(req, res, user, 'demo');
      res.json({ data: user });
    } catch (error) { next(error); }
  });

  router.post('/logout', requireAuth, async (req, res, next) => {
    try {
      const token = readCookie(req.headers.cookie, sessionCookie);
      const activity = await repo.write(state => {
        if (token) delete state.sessions[hashToken(token)];
        return publicActivity(state, addActivity(state, req.user!, 'вышел из сообщества'));
      });
      res.clearCookie(sessionCookie, cookieOptions);
      publishActivity(activity);
      res.json({ data: { success: true } });
    } catch (error) { next(error); }
  });

  router.post('/telegram/start', loginBody, async (_req, res, next) => {
    try {
      if (!config.botInternalSecret) {
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

  const lookupRequest = (id: string) => repo.authRequest ? repo.authRequest(id) : repo.read(state => state.authRequests[id]);
  router.get('/telegram/status/:id', async (req, res, next) => {
    try {
      const id = String(req.params.id);
      const browserToken = readCookie(req.headers.cookie, browserCookie);
      if (!/^[a-f0-9]{48}$/.test(id) || !browserToken || !/^[a-f0-9]{64}$/.test(browserToken)) {
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
      const current = status(await lookupRequest(id));
      if (current !== 'approved') {
        res.json({ data: { status: current } });
        return;
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
      const binding = await repo.read(state => {
        const id = Object.entries(state.telegramUsers).find(([, userId]) => userId === approvedUser.id)?.[0];
        return {id, policy:state.accessSettings.site, managed:isDeploymentAdmin(id,state.managedAdmins)};
      });
      const granted = binding.id ? await telegramAccess(binding.id, approvedUser.id, binding.policy, true) : undefined;
      const access = granted && binding.managed ? accessForLevel('admin','telegram') : granted;
      const user = access ? await synchronizeAccess(approvedUser.id, access, binding.policy?.revision) : undefined;
      if (!user) {
        res.clearCookie(browserCookie, cookieOptions);
        res.json({ data: { status: 'denied' } });
        return;
      }
      await issueSession(req, res, user, 'telegram', binding.policy?.revision);
      res.clearCookie(browserCookie, cookieOptions);
      res.json({ data: { status: 'approved', user } });
    } catch (error) { next(error); }
  });

  router.post('/telegram/cancel/:id', loginBody, async (req, res, next) => {
    try {
      const id = String(req.params.id);
      const browserToken = readCookie(req.headers.cookie, browserCookie);
      if (!/^[a-f0-9]{48}$/.test(id) || !browserToken || !/^[a-f0-9]{64}$/.test(browserToken)) {
        throw failure(400, 'INVALID_LOGIN', 'Откройте вход в этом браузере заново.');
      }
      const browserHash = hashToken(browserToken);
      const existing = await lookupRequest(id);
      if (existing && equalHash(existing.browserHash, browserHash)) {
        await repo.write(state => {
          const request = state.authRequests[id];
          if (request && equalHash(request.browserHash, browserHash)) delete state.authRequests[id];
        });
      }
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
    const binding = requestId ? await repo.read(state => ({request:state.authRequests[requestId], userId:state.telegramUsers[telegramId], policy:state.accessSettings.site})) : undefined;
    const request = binding?.request;
    const bound = request?.telegramId === telegramId && request.promptMessageId === message?.message_id;
    if (!requestId || !message || telegramUser.is_bot || message.chat.type !== 'private' || message.chat.id !== telegramUser.id || !bound) {
      await telegram('answerCallbackQuery', { callback_query_id: query.id, text: 'Запрос закрыт или недействителен.' }).catch(() => undefined);
      return;
    }
    const wantsApproval = match?.[1] === 'ok';
    await telegram('answerCallbackQuery', { callback_query_id: query.id }).catch(() => undefined);
    const granted = wantsApproval && request.status === 'pending' && Date.parse(request.expiresAt) > now()
      ? await telegramAccess(telegramId, binding?.userId, binding?.policy, true) : undefined;
    const outcome = await repo.write((state) => {
      const current = state.authRequests[requestId];
      const decisionTime = now();
      if (!current || current.telegramId !== telegramId || current.promptMessageId !== message.message_id
        || Date.parse(current.expiresAt) <= decisionTime) return { status: 'expired' } as const;
      if (current.status !== 'pending') return { status: current.status, decidedAt: current.decidedAt };
      if (wantsApproval) checkPolicy(state, binding?.policy?.revision);
      current.decidedAt = new Date(decisionTime).toISOString();
      if (!granted) {
        current.status = wantsApproval ? 'denied' : 'rejected';
        return { status: current.status, decidedAt: current.decidedAt };
      }
      const access = bindDeploymentAdmin(state.managedAdmins,telegramId,telegramUser.username) ? accessForLevel('admin','telegram') : granted;
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

  return { router, requireAuth, requireAdmin, userFromCookie, cookieKey, handleTelegramUpdate, flushSessionActivity: activity.flush };
}
