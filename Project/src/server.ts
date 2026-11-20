import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { readConfig } from './config.js';
import { createApp, type Broadcast } from './app.js';
import { MemoryRepository, PostgresRepository, type Repository } from './repository.js';
import { Presence } from './presence.js';
import { createSeed } from './seed.js';

const config = readConfig();
const demoDataFile = resolve(process.cwd(), config.demoDataFile || '.local/demo.json');
let repo: Repository;
const databaseUrl = config.demo ? config.demoDatabaseUrl : config.databaseUrl;
if (databaseUrl) {
  if (config.demo && new URL(databaseUrl).pathname !== '/klan_demo') throw new Error('DEMO_DATABASE_URL must use the isolated klan_demo database');
  const postgres = new PostgresRepository(databaseUrl);
  await postgres.migrate();
  if (config.production) {
    const admins = await postgres.reconcileAdmins();
    console.log(`Deployment administrators checked. Updated: ${admins.updated}. Awaiting @Edhalilov login: ${admins.awaitingEdhalilov}.`);
  }
  if (config.demo) await postgres.write(async state => {
    if (!state.users.length && !state.entities.length) {
      const previousDemo = await MemoryRepository.persistent(demoDataFile, createSeed);
      Object.assign(state, await previousDemo.read(snapshot => snapshot));
      await previousDemo.close();
    }
  });
  repo = postgres;
} else repo = await MemoryRepository.persistent(demoDataFile, createSeed);
const sockets = new WebSocketServer({ noServer: true, maxPayload: 1024 });
const presence = new Presence();
const cookies = new WeakMap<WebSocket, string>();
const pending = new Map<string, string>();
let flushing = false;
let timer: ReturnType<typeof setTimeout> | undefined;
function scheduleBroadcast() {
  if (!timer && !flushing) timer = setTimeout(() => { timer = undefined; void flush(); }, 200);
}
const broadcast: Broadcast = message => {
  if (!sockets.clients.size || pending.has('*')) return;
  if (pending.size >= 128) {
    pending.clear();
    pending.set('*', JSON.stringify({ type: 'invalidate', resource: '*' }));
  } else {
    const key = message.type === 'activity' ? `activity:${message.data.id}` : message.resource;
    pending.set(key, JSON.stringify(message));
  }
  scheduleBroadcast();
};

// A timer and a community update can share the same fresh session checks.
async function flush() {
  if (flushing) return;
  flushing = true;
  const messages = [...pending.values()];
  pending.clear();
  try {
    await Promise.all([...sockets.clients].map(async socket => {
      if (socket.readyState !== WebSocket.OPEN) return;
      try {
        if (!await auth.userFromCookie(cookies.get(socket), false)) { socket.close(4001, 'Session expired'); return; }
        if (socket.readyState !== WebSocket.OPEN) return;
        if (socket.bufferedAmount > 1024 * 1024) socket.terminate();
        else for (const data of messages) socket.send(data);
      } catch { socket.close(1013, 'Session unavailable'); }
    }));
  } finally {
    flushing = false;
    if (pending.size) scheduleBroadcast();
  }
}
const { app, auth } = createApp(repo, config, broadcast);
const server = createServer(app);
server.on('upgrade', async (request, socket, head) => {
  try {
    const user = request.url === '/ws' && request.headers.origin === config.origin
      ? await auth.userFromCookie(request.headers.cookie, false) : undefined;
    if (!user) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); socket.destroy(); return;
    }
    sockets.handleUpgrade(request, socket, head, client => {
      cookies.set(client, request.headers.cookie ?? '');
      sockets.emit('connection', client, request);
      presence.connect(client, user.id);
    });
  } catch { socket.destroy(); }
});
sockets.on('connection', socket => { socket.on('error', () => socket.close()); socket.send(JSON.stringify({ type: 'connected' })); });
const validation = setInterval(() => { presence.heartbeat(); if (!timer) void flush(); }, 30_000);
validation.unref();
server.listen(config.port, config.production ? '0.0.0.0' : '127.0.0.1', () => console.log(`KLAN API: http://localhost:${config.port}${config.demo ? ' (DEMO — isolated local data)' : ''}`));
let closing = false;
async function shutdown() {
  if (closing) return; closing = true;
  clearInterval(validation);
  clearTimeout(timer);
  for (const socket of sockets.clients) socket.close(1001, 'Server shutdown');
  sockets.close();
  server.close(async () => { await repo.close(); process.exit(0); });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
