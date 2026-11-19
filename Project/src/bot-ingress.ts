import { createHash, timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import type { TelegramUpdate } from './auth.js';
import { HttpError } from './errors.js';
import type { BotChannel } from './bot-channel.js';

const id = z.number().int().safe();
// Telegram adds fields over time; validate consumed fields and discard the rest.
const updateSchema = z.object({
  update_id: id.nonnegative(),
  message: z.object({
    from: z.object({ id: id.positive(), is_bot: z.boolean().optional(), first_name: z.string().max(256), last_name: z.string().max(256).optional(), username: z.string().max(64).optional() }).optional(),
    chat: z.object({ id, type: z.enum(['private', 'group', 'supergroup', 'channel']) }),
    text: z.string().max(4096).optional(),
  }).optional(),
});

const botSchema = z.object({ id: id.positive(), username: z.string().regex(/^[A-Za-z0-9_]{5,32}$/) });
const commandResultSchema = z.object({
  botId: id.positive(),
  id: z.uuid(),
  response: z.discriminatedUnion('ok', [
    z.object({ ok: z.literal(false) }),
    z.object({
      ok: z.literal(true),
      result: z.object({ status: z.string().max(32), is_member: z.boolean().optional() }).optional(),
    }),
  ]),
});

export function createBotIngress(secret: string | undefined, handle: (update: TelegramUpdate) => Promise<void>, channel?: BotChannel) {
  const router = Router();
  const expected = secret ? createHash('sha256').update(secret).digest() : undefined;
  const completed = new Set<string>();
  const pending = new Map<string, Promise<void>>();
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (!expected) throw new HttpError(404, 'NOT_FOUND', 'Сервис бота не настроен.');
    const header = req.headers.authorization;
    if (req.headers.origin || req.headers['sec-fetch-site'] || !header?.startsWith('Bearer ') || header.length > 263
      || !timingSafeEqual(expected, createHash('sha256').update(header.slice(7)).digest())) {
      throw new HttpError(401, 'BOT_UNAUTHORIZED', 'Сервис бота не авторизован.');
    }
    if (!req.is('application/json')) throw new HttpError(415, 'JSON_REQUIRED', 'Ожидается JSON.');
    next();
  });
  router.post('/updates', async (req, res) => {
    const update = updateSchema.parse(req.body);
    const botId = req.get('x-klan-telegram-bot-id');
    if (botId !== undefined && !/^[1-9][0-9]{0,15}$/.test(botId)) throw new HttpError(400, 'INVALID_BOT_ID', 'Некорректный ID бота.');
    const key = `${botId ?? ''}:${update.update_id}`;
    if (!completed.has(key)) {
      let operation = pending.get(key);
      if (!operation) {
        operation = handle(update).then(() => {
          completed.add(key);
          // Bound memory. Persistent browser approval remains atomic across restarts.
          if (completed.size > 2000) completed.delete(completed.values().next().value!);
        });
        pending.set(key, operation);
      }
      try { await operation; } finally { pending.delete(key); }
    }
    res.json({ data: { accepted: true } });
  });
  if (channel) {
    router.post('/commands', async (req, res) => {
      const bot = botSchema.parse(req.body);
      const controller = new AbortController();
      res.once('close', () => controller.abort());
      const commands = await channel.next(bot, controller.signal);
      if (!controller.signal.aborted) res.json({ data: { commands } });
    });
    router.post('/command-result', (req, res) => {
      const { botId, id, response } = commandResultSchema.parse(req.body);
      channel.complete(botId, id, response);
      res.sendStatus(204);
    });
  }
  return router;
}
