import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import type { Config } from './config.js';
import type { DatabaseState, Repository } from './repository.js';
import type { AuthDependencies } from './auth.js';
import { HttpError } from './errors.js';
import { publicIdentity } from './community-reads.js';
import { activeTeamMembers } from './domain.js';

const chatId = z.string().regex(/^-[1-9]\d{0,15}$/).refine(id => Number.isSafeInteger(Number(id)));
const group = z.object({ id: chatId, title: z.string().trim().min(1).max(128) });
const input = z.object({
  revision: z.uuid().nullable(),
  membersOnly: z.boolean(),
  adminIds: z.array(z.string().min(1).max(128)).max(1000),
  groups: z.array(group).max(40),
}).refine(value => value.membersOnly || !value.groups.length, 'Для выбранных сообществ нужна проверка членства.');
export type SiteAccess = Omit<z.infer<typeof input>, 'revision'> & { revision: string };

function settingsView(state: DatabaseState, config: Config) {
  const policy = state.accessSettings.site;
  const ids = new Set(policy?.adminIds);
  const active = activeTeamMembers(state.entities);
  const admins = state.users.filter(user => ids.has(user.id)).map(user => publicIdentity(user, active.has(user.id)));
  const groups = policy?.groups ?? (config.telegramGroupMembershipRequired !== false ? config.telegramGroups.map(id => ({id, title:id})) : []);
  return { revision: policy?.revision ?? null, membersOnly: policy?.membersOnly ?? config.telegramGroupMembershipRequired !== false, admins, groups };
}

export function accessSettingsRouter(repo: Repository, config: Config, bot: AuthDependencies, notify: () => void) {
  const router = Router();
  router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  router.get('/', async (_req, res) => {
    res.json({ data: await repo.read(state => settingsView(state, config)) });
  });
  router.post('/resolve', async (req, res) => {
    const { address } = z.object({ address:z.string().trim().min(1).max(160) }).parse(req.body);
    if (chatId.safeParse(address).success) { res.json({data:{id:address, title:address}}); return; }
    const handle = /^@([a-z][a-z0-9_]{3,31})$/i.exec(address)?.[1]
      ?? /^(?:https?:\/\/)?t\.me\/([a-z][a-z0-9_]{3,31})(?:\/[1-9]\d*){0,2}\/?$/i.exec(address)?.[1];
    if (!handle || handle.toLowerCase() === 'joinchat') throw new HttpError(400, 'INVALID_CHAT', 'Введите @имя, публичную ссылку t.me или числовой ID закрытой группы или канала.');
    const chat = await bot.telegramRequest?.<{id:number; type:string; title:string}>('getChat', {chat_id:'@' + handle}).catch(() => undefined);
    if (!chat || !['group','supergroup','channel'].includes(chat.type) || !chatId.safeParse(String(chat.id)).success || !chat.title?.trim()) {
      throw new HttpError(422, 'CHAT_UNAVAILABLE', 'Бот не смог найти группу или канал. Проверьте адрес и доступ бота либо укажите числовой ID.');
    }
    res.json({data:{id:String(chat.id),title:chat.title.trim().slice(0,128)}});
  });
  router.put('/', async (req, res) => {
    const values = input.parse(req.body);
    const data = await repo.write(state => {
      if ((state.accessSettings.site?.revision ?? null) !== values.revision) {
        throw new HttpError(409, 'SETTINGS_CHANGED', 'Другой администратор изменил настройки. Загрузите актуальный список.');
      }
      const users = new Set(state.users.map(user => user.id));
      if (values.adminIds.some(id => !users.has(id))) throw new HttpError(400, 'UNKNOWN_USER', 'Один из выбранных участников больше не существует.');
      if (values.membersOnly && !values.groups.length && !Object.values(state.telegramUsers).some(id => values.adminIds.includes(id))) {
        throw new HttpError(400, 'NO_LOGIN_AVAILABLE', 'Чтобы ограничить вход только администраторами, выберите хотя бы одного участника с привязанным Telegram.');
      }
      state.accessSettings.site = { revision:randomUUID(), membersOnly:values.membersOnly, adminIds:[...new Set(values.adminIds)],
        groups:[...new Map(values.groups.map(chat => [chat.id, chat])).values()] };
      return settingsView(state, config);
    });
    notify();
    res.json({data});
  });
  return router;
}
