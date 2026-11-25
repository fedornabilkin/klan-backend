import { randomUUID } from 'node:crypto';
import { EventEmitter, once } from 'node:events';

export type TelegramMethod = 'getChat' | 'getChatMember' | 'sendMessage' | 'answerCallbackQuery' | 'editMessageText';
export type TelegramCommand = { id: string; method: TelegramMethod; payload: object };
export type BotIdentity = { id: number; username: string };
export type CommandResult = { ok: false } | { ok: true; result?: unknown };

type PendingCommand = {
  command: TelegramCommand;
  dispatched: boolean;
  complete: (result: CommandResult) => void;
};

const pollTimeoutMs = 20_000;
const leaseMs = 60_000;
const commandTimeoutMs = 12_000;

export function createBotChannel(now = Date.now) {
  const events = new EventEmitter();
  const pending = new Map<string, PendingCommand>();
  let active: { bot: BotIdentity; expiresAt: number } | undefined;
  let poll: AbortController | undefined;

  function botUsername() {
    return active && active.expiresAt > now() ? active.bot.username : undefined;
  }

  async function next(bot: BotIdentity, signal: AbortSignal): Promise<TelegramCommand[]> {
    if (active && active.bot.id !== bot.id) {
      for (const entry of pending.values()) entry.complete({ ok: false });
    }
    active = { bot, expiresAt: now() + leaseMs };
    poll?.abort();
    const current = new AbortController();
    poll = current;
    const stop = AbortSignal.any([current.signal, signal, AbortSignal.timeout(pollTimeoutMs)]);
    const available = () => Array.from(pending.values()).filter(entry => !entry.dispatched).slice(0, 16);
    try {
      while (!stop.aborted) {
        const batch = available();
        if (batch.length) {
          for (const entry of batch) entry.dispatched = true;
          return batch.map(entry => entry.command);
        }
        await once(events, 'command', { signal: stop });
      }
    } catch (error) {
      if (!stop.aborted) throw error;
    } finally {
      if (poll === current) poll = undefined;
    }
    return [];
  }

  function complete(botId: number, id: string, result: CommandResult) {
    if (active?.bot.id !== botId) return;
    const entry = pending.get(id);
    if (entry?.dispatched) entry.complete(result);
  }

  async function telegramRequest<T>(method: TelegramMethod, payload: object): Promise<T> {
    if (!botUsername() || pending.size >= 256) throw new Error('Bot unavailable');
    const id = randomUUID();
    return new Promise<T>((resolve, reject) => {
      const complete = (result: CommandResult) => {
        clearTimeout(timer);
        pending.delete(id);
        if (result.ok) resolve(result.result as T);
        else reject(new Error('Bot command unavailable'));
      };
      const timer = setTimeout(() => complete({ ok: false }), commandTimeoutMs);
      pending.set(id, { command: { id, method, payload }, dispatched: false, complete });
      events.emit('command');
    });
  }

  return { botUsername, telegramRequest, next, complete };
}

export type BotChannel = ReturnType<typeof createBotChannel>;
