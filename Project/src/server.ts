import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { readConfig } from './config.js';
import { createApp, type Broadcast } from './app.js';
import { MemoryRepository, PostgresRepository, type Repository } from './repository.js';
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
const cookies = new WeakMap<WebSocket, string>();
let pendingMessages: string[] = [];
let flushScheduled = false;
const broadcast: Broadcast = message => {
  pendingMessages.push(JSON.stringify(message));
  if (flushScheduled) return;
  flushScheduled = true;
  queueMicrotask(() => {
  const messages = pendingMessages;
  pendingMessages = [];
  flushScheduled = false;
  for (const socket of sockets.clients) if (socket.readyState === WebSocket.OPEN) {
    void auth.userFromCookie(cookies.get(socket), false).then(user => {
      if (!user) { socket.close(4001, 'Session expired'); return; }
      if (socket.readyState !== WebSocket.OPEN) return;
      if (socket.bufferedAmount > 1024 * 1024) socket.close(1013, 'Slow connection');
      else for (const data of messages) socket.send(data);
    }).catch(() => socket.close(4001, 'Session unavailable'));
  }
  });
};
const { app, auth } = createApp(repo, config, broadcast);
const server = createServer(app);
server.on('upgrade', async (request, socket, head) => {
  try {
    if (request.url !== '/ws' || request.headers.origin !== config.origin || !await auth.userFromCookie(request.headers.cookie, false)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); socket.destroy(); return;
    }
    sockets.handleUpgrade(request, socket, head, client => { cookies.set(client, request.headers.cookie ?? ''); sockets.emit('connection', client, request); });
  } catch { socket.destroy(); }
});
sockets.on('connection', socket => { socket.on('error', () => socket.close()); socket.send(JSON.stringify({ type: 'connected' })); });
const validation = setInterval(() => {
  for (const socket of sockets.clients) void auth.userFromCookie(cookies.get(socket), false).then(user => { if (!user) socket.close(4001, 'Session expired'); }).catch(() => socket.close(4001, 'Session unavailable'));
}, 30_000);
validation.unref();
server.listen(config.port, config.production ? '0.0.0.0' : '127.0.0.1', () => console.log(`KLAN API: http://localhost:${config.port}${config.demo ? ' (DEMO — isolated local data)' : ''}`));
let closing = false;
async function shutdown() {
  if (closing) return; closing = true;
  clearInterval(validation);
  for (const socket of sockets.clients) socket.close(1001, 'Server shutdown');
  sockets.close();
  server.close(async () => { await repo.close(); process.exit(0); });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
