import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import express, { type ErrorRequestHandler, type Request } from 'express';
import compression from 'compression';
import { constants as zlib } from 'node:zlib';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import type { Activity, Entity, Resource, User, UserIdentity } from './shared/contracts.js';
import type { Config } from './config.js';
import type { CommunityPage, DatabaseState, RecordUsernameChange, Repository } from './repository.js';
import { challengePodiums, challengeTotals, publicIdentity, dashboardCards, dashboardTeamRanking, rankingCandidates, statistics } from './community-reads.js';
import { compactDetail, entityCard, teamChallengeSummaries, userCard } from './resource-reads.js';
import { excludeTeamMember, setTeamRole } from './team-members.js';
import { activeTeamMembers, publicActivity } from './domain.js';
import { pageResponses } from './page-cache.js';
import { userPath } from './shared/user-links.js';
import { createAuth, type AuthDependencies } from './auth.js';
import { createBotIngress } from './bot-ingress.js';
import { createBotChannel } from './bot-channel.js';
import { createCatalogRouter, findOrCreateCatalogEntry } from './catalog.js';
import { createAnalyticsRouter } from './analytics.js';
import { membersMissing, missingMemberFields } from './admin-member-filters.js';
import { likesEnabled } from './entity-likes.js';
import { createLocationCatalogRouter } from './location-catalog.js';
import { createAndAssignProfileTag } from './profile-tags.js';
import { hasCapability, requireCapability } from './access.js';
import { HttpError, notFound, forbidden } from './errors.js';
import { addActivity, canonicalTags, createEntity, editEntity, filtered, getEntity, getUser, hydrateEntity, hydrateUser, joinEntity, leaveEntity, listResource, paginate, profileSchema, querySchema, requireAdmin, resources, writeChallengeDay, updateProfile, visibleState } from './domain.js';

export type Broadcast = (message: { type: 'invalidate'; resource: string } | { type: 'activity'; data: Activity }) => void;
export function createApp(repo: Repository, config: Config, broadcast: Broadcast = () => undefined, authDependencies?: AuthDependencies, onlineUserIds: () => string[] = () => []) {
  const app = express();
  app.disable('x-powered-by');
  if (config.production) app.set('trust proxy', 1);
  app.use(helmet({ contentSecurityPolicy: config.production ? {
    directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"], imgSrc: ["'self'", 'data:', 'https:'], connectSrc: ["'self'", 'wss:'], fontSrc: ["'self'", 'data:'], objectSrc: ["'none'"], frameAncestors: ["'none'"] },
  } : false, crossOriginEmbedderPolicy: false }));
  app.use(compression({ level: 1, brotli: { params: { [zlib.BROTLI_PARAM_QUALITY]: 2 } } }));
  app.use(express.json({ limit: '256kb' }));
  app.use('/api', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  app.use('/api', (req, _res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const origin = req.headers.origin;
    // Browser writes require a matching Origin. JSON-only prevents form-based CSRF.
    if (origin !== config.origin) return next(new HttpError(403, 'INVALID_ORIGIN', 'Запрос отправлен с недоверенного сайта'));
    if (req.headers['sec-fetch-site'] === 'cross-site') return next(forbidden());
    if (!req.is('application/json') && req.method !== 'DELETE') return next(new HttpError(415, 'JSON_REQUIRED', 'Ожидается JSON'));
    next();
  });
  app.get('/api/health', async (_req, res) => {
    try { await repo.ping?.(); res.json({ data: { status: 'ok', demo: config.demo } }); }
    catch { res.status(503).json({ data: { status: 'unavailable', demo: config.demo } }); }
  });
  const notify = (resource: string, activity?: Activity) => {
    broadcast({ type: 'invalidate', resource });
    broadcast({ type: 'invalidate', resource: 'dashboard' });
    broadcast({ type: 'invalidate', resource: 'stats' });
    if (activity) broadcast({ type: 'activity', data: activity });
  };
  const botChannel = createBotChannel();
  const auth = createAuth(repo, config, activity => notify('users', activity), authDependencies ?? botChannel);
  // A service endpoint, outside browser cookie authentication and Origin handling.
  app.use('/internal/telegram', createBotIngress(config.botInternalSecret, auth.handleTelegramUpdate, botChannel));
  app.use(['/api/auth/demo', '/api/auth/telegram/start'], rateLimit({ windowMs: 5 * 60 * 1000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: { code: 'RATE_LIMIT', message: 'Слишком много попыток входа. Попробуйте позже.' } } }));
  app.use('/api/auth', rateLimit({ windowMs: 5 * 60 * 1000, limit: 400, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: { code: 'RATE_LIMIT', message: 'Слишком много запросов. Попробуйте позже.' } } }), auth.router);
  app.use('/api', rateLimit({ windowMs: 60 * 1000, limit: 500, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: { code: 'RATE_LIMIT', message: 'Слишком много запросов. Попробуйте через минуту.' } } }));
  app.use('/api', auth.requireAuth);
  app.use('/api/location-catalog', createLocationCatalogRouter(repo, activity => notify('location-catalog', activity)));
  app.use('/api/admin/catalogs', createCatalogRouter(repo, notify));
  app.use('/api/admin/analytics', createAnalyticsRouter(repo));
  const query = (req: Request) => querySchema.parse(req.query);
  const resource = (req: Request) => {
    const value = String(req.params.resource);
    if (!resources.includes(value as Resource)) throw notFound();
    return value as Resource;
  };
  const mutate = async <T>(actor: User, collection: string, action: string | ((state: DatabaseState) => string | undefined), fn: (state: DatabaseState, audit: RecordUsernameChange) => T, target?: (value: T) => Activity['target']) => {
    const outcome = await repo.write((state, audit) => {
      const verb = typeof action === 'string' ? action : action(state);
      const data = fn(state, audit); const destination = target?.(data);
      const draft = !!destination && state.entities.some(entity => entity.status === 'draft' && destination.path === `/${entity.type}/${entity.id}`);
      return { data, activity: verb ? publicActivity(state, addActivity(state, actor, verb, destination)) : undefined, draft };
    });
    // Draft activities remain available to administrators via the feed; never broadcast their titles to members.
    notify(collection, outcome.draft ? undefined : outcome.activity);
    return { data: outcome.data };
  };
  const entityTarget = (entity: Pick<Entity, 'title' | 'type' | 'id'>) => ({ title: entity.title, path: `/${entity.type}/${entity.id}` });

  const sendPage = pageResponses(repo);
  const readPage = <T>(page: CommunityPage, fn: (state: DatabaseState) => T, at = new Date()) =>
    repo.readPage ? repo.readPage(page, fn, at) : repo.read(fn);
  for (const catalog of ['tags', 'items'] as const) {
    app.get(`/api/${catalog}`, (req, res, next) => {
      if (catalog !== 'tags' || req.query.usage !== '1') return next();
      return sendPage(req, res, 'tag-usage', () => readPage('tag-usage', state => {
        const counts = new Map<string,number>();
        for (const user of state.users) for (const tag of user.tags) counts.set(tag.id,(counts.get(tag.id) ?? 0)+1);
        return state.tags.map(tag => ({count:counts.get(tag.id) ?? 0,...tag}));
      }));
    });
    app.get(`/api/${catalog}`, (req, res) => sendPage(req, res, catalog, () =>
      readPage(catalog, state => state[catalog].slice().sort((a, b) => a.name.localeCompare(b.name, 'ru')))));
  }
  for (const collection of ['tags', 'items'] as const) {
    app.post(`/api/${collection}`, async (req, res) => {
      const result = await mutate(req.user!, collection, collection === 'tags' ? 'добавил тег' : 'добавил предмет', state => findOrCreateCatalogEntry(state, collection, req.body));
      res.status(201).json(result);
    });
  }
  app.post('/api/users/:id/tags', async (req, res) => {
    const id = req.params.id === 'me' ? req.user!.id : String(req.params.id);
    const result = await mutate(req.user!, 'users', 'добавил тег в профиль', state => createAndAssignProfileTag(state, id, req.body, req.user!), user => ({ title: user.name, path: userPath(user) }));
    broadcast({ type: 'invalidate', resource: 'tags' });
    res.json(result);
  });
  app.get('/api/users/me/export', async (req, res) => {
    const { name, firstName, middleName, lastName, callsign, username, birthDate, clanJoinedOn, bio, location, facts, interests, achievements, tags } =
      repo.exportProfile ? await repo.exportProfile(req.user!.id) : await repo.read(s => hydrateUser(s,getUser(s,req.user!.id)));
    const profile = { name, firstName, middleName, lastName, callsign, username, birthDate, clanJoinedOn, bio, location, facts, interests, achievements, tags };
    res.json({ data: { version: 1, profile } });
  });
  app.post('/api/users/me/import', async (req, res) => {
    const { profile } = z.object({ profile: profileSchema }).strict().parse(req.body);
    res.json(await mutate(req.user!, 'users', 'импортировал профиль', state => {
      if (profile.tags) profile.tags = profile.tags.map(tag => {
        return findOrCreateCatalogEntry(state, 'tags', { name: tag.name });
      });
      return updateProfile(state, req.user!.id, profile, req.user!);
    }, user => ({ title: user.name, path: userPath(user) })));
  });
  app.get('/api/presence/users', async (req, res) => {
    const page = paginate(onlineUserIds(), query(req));
    const ids = page.data;
    const data = !ids.length ? [] : repo.presenceProfiles ? await repo.presenceProfiles(ids) : await repo.read(state => {
      const members = activeTeamMembers(state.entities);
      const users = new Map(state.users.map(user => [user.id, user]));
      return ids.flatMap(id => { const user = users.get(id); return user ? [publicIdentity(user, members.has(id))] : []; });
    });
    res.json({ data, meta:page.meta });
  });
  app.get('/api/activity', async (req, res) => {
    const params = query(req);
    res.json(repo.activity ? await repo.activity(params, hasCapability(req.user, 'content.manage')) : await repo.read(state => {
      const result = paginate(visibleState(state, req.user!).activities.slice().sort((a,b) => b.createdAt.localeCompare(a.createdAt)), params);
      return {...result,data:result.data.map(a => publicActivity(state,a))};
    }));
  });
  app.get('/api/geography', async (req, res) => {
    const params = query(req);
    const unfiltered = !params.q && !params.tag && !params.city && !params.category && !params.status && params.sort === '-createdAt';
    await sendPage(req, res, unfiltered ? 'geography' : undefined, async () => {
      const users = repo.geographyUsers ? await repo.geographyUsers(unfiltered) : await repo.read(state => {
        const members = activeTeamMembers(state.entities);
        return state.users.map(user => ({...user, hasActiveTeam:members.has(user.id)}));
      });
      const cities = new Map<string, { id: string; city: string; country: string; lat: number; lng: number; count: number; users: UserIdentity[] }>();
      for (const user of filtered(users, params)) {
        const { lat, lng } = user.location;
        const city = user.location.city.trim(), country = user.location.country.trim();
        if (!city || typeof lat !== 'number' || !Number.isFinite(lat) || lat < -90 || lat > 90
          || typeof lng !== 'number' || !Number.isFinite(lng) || lng < -180 || lng > 180) continue;
        const key = `${country}:${city}`.toLocaleLowerCase('ru');
        const point = cities.get(key) ?? { id: key, city, country, lat, lng, count: 0, users: [] };
        point.count++;
        if (point.users.length < 5) point.users.push({ id: user.id, publicId: user.publicId ?? undefined, name: user.name, firstName:user.firstName, lastName:user.lastName, callsign:user.callsign, hasActiveTeam:user.hasActiveTeam, initials: user.initials, color: user.color });
        cities.set(key, point);
      }
      return [...cities.values()];
    });
  });
  app.get('/api/dashboard', async (req, res) => {
    const now = new Date();
    const scope = hasCapability(req.user, 'content.manage') ? 'all' : 'published';
    const compact = req.query.view === 'cards';
    await sendPage(req, res, `${compact ? 'dashboard-cards' : 'dashboard'}-${scope}`, () => compact && repo.dashboardOverview
      ? repo.dashboardOverview(now,scope === 'all') : readPage('dashboard', raw => {
      const state = visibleState(raw, req.user!);
      const cards = dashboardCards(state.entities, now);
      const challenge = compact && rankingCandidates(state.entities, now).find(e => e.results?.some(r => r.team?.id));
      const scores = new Map<string, number>();
      if (challenge) for (const { team, value } of challenge.results ?? []) {
        if (team) scores.set(team.id, (scores.get(team.id) ?? 0) + value);
      }
      const mapUsers = state.users.filter(({ location }) => location.city.trim()
        && typeof location.lat === 'number' && Number.isFinite(location.lat) && location.lat >= -90 && location.lat <= 90
        && typeof location.lng === 'number' && Number.isFinite(location.lng) && location.lng >= -180 && location.lng <= 180);
      const card = (e: Entity) => compact ? entityCard(e) : hydrateEntity(state,e);
      return { activityTotal:state.activities.length, stats: { users: state.users.length, cities: new Set(mapUsers.map(user => `${user.location.country.trim()}:${user.location.city.trim()}`.toLocaleLowerCase('ru'))).size, ...cards.counts },
        ...(compact && { teamRanking: challenge ? dashboardTeamRanking(challenge, state.entities, scores) : null }),
        events: cards.events.map(card), challenges: cards.challenges.map(card), teams: cards.teams.map(card), activity: state.activities.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, compact ? 5 : 20).map(a => publicActivity(state,a)) };
    }, now));
  });
  app.get('/api/stats', async (req, res) => {
    const includeDrafts = hasCapability(req.user, 'content.manage');
    await sendPage(req, res, `stats-${includeDrafts ? 'all' : 'published'}`, () => repo.statistics ? repo.statistics(includeDrafts) : repo.read(raw => {
      const state = visibleState(raw, req.user!);
      const members = activeTeamMembers(state.entities);
      const podiums = challengePodiums(state.entities.filter(e => e.type === 'challenges'),
        state.users.map(user => publicIdentity(user, members.has(user.id))), state.entities.filter(e => e.type === 'teams' && e.status !== 'draft'),
        challengeTotals(state.entities));
      return statistics(state.users.map(u => ({ city: u.location.city, tags: u.tags, achievements: u.achievements })),
        state.entities.filter(e => e.type === 'teams').map(e => ({ id: e.id, publicId: e.publicId, title: e.title, count: e.participants.length })),
        state.activities.map(a => a.createdAt.slice(0, 10)), podiums);
    }));
  });
  app.put('/api/teams/:id/members/:userId/role', async (req, res) => {
    requireCapability(req.user!, 'members.manage');
    res.json(await mutate(req.user!, 'teams', 'изменил роль участника команды', state =>
      setTeamRole(state, String(req.params.id), String(req.params.userId), req.body, req.user!), entityTarget));
  });
  app.post('/api/teams/:id/members/:userId/exclude', async (req, res) => {
    requireCapability(req.user!, 'members.manage');
    const result = await mutate(req.user!, 'teams', 'исключил участника из команды', state =>
      excludeTeamMember(state, String(req.params.id), String(req.params.userId), req.body, req.user!), entityTarget);
    broadcast({ type: 'invalidate', resource: 'users' });
    res.json(result);
  });
  app.post('/api/:resource/:id/join', async (req, res) => {
    const collection = resource(req);
    res.json(await mutate(req.user!, collection, collection === 'teams' ? 'присоединился к команде' : collection === 'challenges' ? 'принял участие в челлендже' : 'записался на мероприятие', state => joinEntity(state, collection, String(req.params.id), req.user!, req.body), entityTarget));
    notify('users');
  });
  app.delete('/api/:resource/:id/join', async (req, res) => {
    const collection = resource(req), id = String(req.params.id), actor = req.user!;
    const departure = (state: DatabaseState) => getEntity(state, collection, id).participants.some(p => p.user.id === actor.id)
      ? 'отменил участие' : undefined;
    res.json(await mutate(actor, collection, departure, state => leaveEntity(state, collection, id, actor), entityTarget));
    notify('users');
  });
  app.put('/api/events/:id/items', async (req, res) => {
    const { items, comment } = z.object({
      items: z.array(z.object({ id: z.string().min(1).optional(), name: z.string().trim().min(1).max(80),
        quantity: z.number().int().positive().max(999).default(1) }).strict()).max(50),
      comment: z.string().trim().max(1000).optional(),
    }).strict().parse(req.body);
    let catalogChanged = false;
    const result = await mutate(req.user!, 'events', 'обновил детали своего участия', state => {
      const entity = getEntity(state, 'events', String(req.params.id));
      if (entity.status === 'draft' && !hasCapability(req.user!, 'content.manage')) throw notFound();
      const participant = entity.participants.find(p => p.user.id === req.user!.id);
      if (!participant) throw new HttpError(403, 'JOIN_REQUIRED', 'Сначала запишитесь на мероприятие');
      if (entity.schedule && Date.parse(entity.schedule.end) <= Date.now()) throw new HttpError(409, 'EVENT_FINISHED', 'Мероприятие завершено');
      const previousCount = state.items.length;
      const chosen = items.map(item => {
        const catalogItem = item.id ? state.items.find(existing => existing.id === item.id)
          : findOrCreateCatalogEntry(state, 'items', { name: item.name });
        if (!catalogItem) throw new HttpError(400, 'UNKNOWN_ITEM', 'Предмет не найден в справочнике');
        return { ...catalogItem, quantity: item.quantity };
      });
      if (new Set(chosen.map(item => item.id)).size !== chosen.length) throw new HttpError(400, 'DUPLICATE_ITEM', 'Предмет указан несколько раз');
      participant.items = chosen;
      if (comment !== undefined) {
        if (comment) participant.comment = comment;
        else delete participant.comment;
      }
      catalogChanged = state.items.length !== previousCount;
      return hydrateEntity(state, entity);
    }, entityTarget);
    if (catalogChanged) notify('items');
    res.json(result);
  });
  app.put('/api/challenges/:id/results', async (req, res) => {
    const {data} = await mutate(req.user!, 'challenges', 'добавил результат в челлендж', state => {
      const {entity, day} = writeChallengeDay(state, String(req.params.id), req.user!, req.body);
      return {target:entityTarget(entity), result:req.query.view === 'day' ? day : hydrateEntity(state, entity)};
    }, saved => saved.target);
    res.json({data:data.result});
  });
  app.put('/api/books/:id/read', async (req, res) => {
    const { read } = z.object({ read: z.boolean() }).strict().parse(req.body);
    res.json(await mutate(req.user!, 'books', read ? 'прочитал книгу' : 'снял отметку о прочтении', state => {
      const entity = getEntity(state, 'books', String(req.params.id));
      if (entity.status === 'draft' && !hasCapability(req.user!, 'content.manage')) throw notFound();
      entity.readers = (entity.readers ?? []).filter(user => user.id !== req.user!.id);
      if (read) entity.readers.push(getUser(state, req.user!.id));
      return hydrateEntity(state, entity);
    }, entityTarget));
    notify('users');
  });
  app.get('/api/admin/users', async (req, res) => {
    requireCapability(req.user!, 'members.manage');
    res.setHeader('Cache-Control', 'private, no-store');
    const missing = missingMemberFields.parse(req.query.missing);
    const params = query(req);
    if (repo.list) return res.json(await repo.list('users', params, true, true, missing));
    res.json(await repo.read(state => {
      const page = paginate(filtered(membersMissing(state, missing), params), params);
      return { ...page, data: page.data.map(user => userCard(hydrateUser(state, user), true)) };
    }));
  });
  const withLikes = async <T extends {id: string}>(rows: T[], viewer: string) => {
    const totals = await repo.likeSummaries(rows.map(row => row.id), viewer);
    return rows.map(row => ({...row, likes: totals.get(row.id) ?? {count: 0, liked: false}}));
  };
  app.put('/api/:resource/:id/like', async (req, res) => {
    const collection = resource(req);
    if (collection === 'users' || !likesEnabled(collection)) throw notFound();
    const {liked} = z.object({liked: z.boolean()}).strict().parse(req.body);
    res.set('Cache-Control', 'private, no-store').json({data: await repo.write({
      resource: collection, id: String(req.params.id), userId: req.user!.id, liked, drafts: hasCapability(req.user, 'content.manage'),
    })});
  });
  app.get('/api/:resource', async (req, res) => {
    const collection = resource(req), params = query(req), cards = req.query.view === 'cards';
    if (collection === 'teams') {
      if (req.query.limit === undefined) params.limit = 30;
      if (req.query.sort === undefined) params.sort = 'name';
    }
    const page = repo.list ? await repo.list(collection, params, hasCapability(req.user, 'content.manage'), cards) : await repo.read(raw => {
      const state = visibleState(raw,req.user!);
      if (!cards) return listResource(state,collection,params);
      if (collection === 'users') {
        const page = paginate(filtered(state.users,params),params);
        return {...page,data:page.data.map(u => userCard(hydrateUser(state,u),hasCapability(req.user,'content.manage')))};
      }
      const page = paginate(filtered(state.entities.filter(e => e.type === collection),params),params);
      return {...page,data:page.data.map(entityCard)};
    });
    if (likesEnabled(collection)) {
      res.set('Cache-Control', 'private, no-store');
      if (page.data.length) return res.json({...page, data: await withLikes(page.data, req.user!.id)});
    }
    res.json(page);
  });
  app.get('/api/:resource/:id', async (req, res) => {
    const collection = resource(req), compact = req.query.view === 'detail';
    const id = req.params.id === 'me' ? req.user!.id : String(req.params.id);
    const drafts = hasCapability(req.user, 'content.manage');
    const cacheKey = compact && (collection === 'teams' || collection === 'challenges')
      ? `${collection === 'teams' ? 'team' : 'challenge'}-${drafts ? 'all' : 'published'}` as const : undefined;
    const load = () => repo.detail ? repo.detail(collection,id,drafts,compact) : repo.read(raw => {
      const state = visibleState(raw,req.user!);
      if (collection === 'users') return hydrateUser(state,getUser(state,id));
      const entity = getEntity(state,collection,id);
      if (!compact) return hydrateEntity(state,entity);
      const members = activeTeamMembers(state.entities);
      const users = new Map(state.users.map(user => [user.id,{...user,hasActiveTeam:members.has(user.id)}]));
      if (collection === 'teams') Object.assign(entity, teamChallengeSummaries(state.entities, entity.id));
      return compactDetail(entity,users,new Map(state.entities.filter(t => t.type === 'teams')
        .map(t => [t.id,{id:t.id,publicId:t.publicId,title:t.title}])));
    });
    if (likesEnabled(collection)) {
      const [data] = await withLikes([await load()], req.user!.id);
      return res.set('Cache-Control', 'private, no-store').json({data});
    }
    await sendPage(req, res, cacheKey, load, id);
  });
  app.post('/api/:resource', async (req, res) => {
    const collection = resource(req);
    if (collection === 'users') throw new HttpError(400, 'TELEGRAM_REQUIRED', 'Участники создаются при входе через Telegram');
    res.status(201).json(await mutate(req.user!, collection, 'добавил запись', state => createEntity(state, collection, req.body, req.user!), entityTarget));
  });
  const saveProfile = (actor: User, id: string, input: unknown, adminEditor = false) =>
    mutate(actor, 'users', 'обновил профиль', (state, recordUsernameChange) =>
      updateProfile(state, id, input, actor, { adminEditor, recordUsernameChange }), user => ({ title: user.name, path: userPath(user) }));
  app.patch('/api/admin/users/:id', async (req, res) => {
    requireCapability(req.user!, 'members.manage');
    res.json(await saveProfile(req.user!, String(req.params.id), req.body, true));
  });
  app.patch('/api/:resource/:id', async (req, res) => {
    const collection = resource(req); const id = req.params.id === 'me' ? req.user!.id : String(req.params.id);
    if (collection === 'users') res.json(await saveProfile(req.user!, id, req.body));
    else res.json(await mutate(req.user!, collection, 'изменил запись', state => editEntity(state, collection, id, req.body, req.user!), entityTarget));
  });
  app.delete('/api/:resource/:id', async (req, res) => {
    const collection = resource(req); const id = String(req.params.id);
    requireCapability(req.user!, collection === 'users' ? 'members.manage' : 'content.manage');
    res.json(await mutate(req.user!, collection, 'удалил запись', state => {
      if (collection === 'users') {
        const userId = getUser(state, id).id;
        if (userId === req.user!.id) throw new HttpError(409, 'SELF_DELETE', 'Нельзя удалить собственную административную учётную запись');
        state.users = state.users.filter(user => user.id !== userId);
        for (const entity of state.entities) {
          entity.participants = entity.participants.filter(p => p.user.id !== userId);
          entity.results = entity.results?.filter(r => r.user.id !== userId);
          entity.readers = entity.readers?.filter(user => user.id !== userId);
          if (entity.author?.id === userId) delete entity.author;
          if (entity.organizer && 'userId' in entity.organizer && entity.organizer.userId === userId) delete entity.organizer;
        }
        for (const [token, session] of Object.entries(state.sessions)) if (session.userId === userId) delete state.sessions[token];
        for (const [telegramId, linkedUserId] of Object.entries(state.telegramUsers)) if (linkedUserId === userId) delete state.telegramUsers[telegramId];
        for (const [requestId, request] of Object.entries(state.authRequests)) if (request.userId === userId) delete state.authRequests[requestId];
      } else {
        const deletedEntity = getEntity(state, collection, id);
        const entityId = deletedEntity.id;
        if (collection === 'teams' && state.entities.some(entity => entity.type === 'challenges' && (entity.participants.some(p => p.team?.id === entityId) || entity.results?.some(r => r.team?.id === entityId)))) throw new HttpError(409, 'TEAM_HISTORY_EXISTS', 'У команды есть история челленджей. Переведите её в архив.');
        // A removed draft must not make its previously hidden activity public.
        if (deletedEntity.status === 'draft') state.activities = state.activities.filter(activity => ![`/${collection}/${entityId}`,`/${collection}/${deletedEntity.publicId}`].includes(activity.target?.path ?? ''));
        state.entities = state.entities.filter(entity => entity.id !== entityId);
      }
      return { success: true };
    }));
  });
  app.use('/api', (_req, _res, next) => next(notFound()));
  const staticDirectory = process.env.STATIC_DIR ? resolve(process.env.STATIC_DIR) : undefined;
  if (config.production && staticDirectory && existsSync(resolve(staticDirectory, 'index.html'))) {
    app.use(express.static(staticDirectory, { index: false, maxAge: '1h' }));
    app.get('/{*path}', (_req, res) => { res.set('Cache-Control', 'no-cache'); res.sendFile(resolve(staticDirectory, 'index.html')); });
  }
  const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
    if (error instanceof z.ZodError) { res.status(400).json({ error: { code: 'VALIDATION', message: error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ') } }); return; }
    const trusted = error instanceof HttpError;
    const status = trusted ? error.status : error.type === 'entity.parse.failed' ? 400 : error.type === 'entity.too.large' ? 413 : 500;
    if (status >= 500) console.error('API operation failed:', trusted ? error.code : error.name ?? 'Error');
    res.status(status).json({ error: { code: trusted ? error.code : status === 500 ? 'INTERNAL_ERROR' : 'INVALID_BODY', message: trusted ? error.message : status === 500 ? 'Не удалось выполнить запрос. Попробуйте ещё раз.' : 'Некорректный JSON или превышен размер запроса' } });
  };
  app.use(errorHandler);
  return { app, auth };
}
