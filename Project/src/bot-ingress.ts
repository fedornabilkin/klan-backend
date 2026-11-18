import { createHash, timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import type { TelegramUpdate } from './auth.js';
import { HttpError } from './errors.js';

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

export function createBotIngress(secret: string | undefined, handle: (update: TelegramUpdate) => Promise<void>) {
  const router = Router();
  const expected = secret ? createHash('sha256').update(secret).digest() : undefined;
  const completed = new Set<number>();
  const pending = new Map<number, Promise<void>>();
  router.post('/updates', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!expected) throw new HttpError(404, 'NOT_FOUND', 'Сервис бота не настроен.');
    const header = req.headers.authorization;
    if (req.headers.origin || req.headers['sec-fetch-site'] || !header?.startsWith('Bearer ') || header.length > 263
      || !timingSafeEqual(expected, createHash('sha256').update(header.slice(7)).digest())) {
      throw new HttpError(401, 'BOT_UNAUTHORIZED', 'Сервис бота не авторизован.');
    }
    if (!req.is('application/json')) throw new HttpError(415, 'JSON_REQUIRED', 'Ожидается JSON.');
    const update = updateSchema.parse(req.body);
    if (!completed.has(update.update_id)) {
      let operation = pending.get(update.update_id);
      if (!operation) {
        operation = handle(update).then(() => {
          completed.add(update.update_id);
          // Bound memory. Persistent browser approval remains atomic across restarts.
          if (completed.size > 2000) completed.delete(completed.values().next().value!);
        });
        pending.set(update.update_id, operation);
      }
      try { await operation; } finally { pending.delete(update.update_id); }
    }
    res.json({ data: { accepted: true } });
  });
  return router;
}
