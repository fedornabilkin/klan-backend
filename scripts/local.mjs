import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { open, readFile, writeFile, rename, mkdir, unlink, access } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { dirname, resolve, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { parse } from 'dotenv';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const local = join(root, '.local');
const statePath = join(local, 'managed-services.json');
const lockPath = join(local, 'services.lock');
const run = promisify(execFile);
const action = process.argv[2];
let shellPromise;
const psQuote = value => `'${String(value).replaceAll("'", "''")}'`;
const normalized = value => resolve(value).toLowerCase();
let state;

async function powershellPath() {
  shellPromise ??= (async () => {
    try {
      const found = await run('where.exe', ['pwsh.exe'], { windowsHide: true, timeout: 5000 });
      const first = found.stdout.split(/\r?\n/).find(Boolean);
      if (first) return first;
    } catch { /* PowerShell 7 is optional on a developer machine. */ }
    return 'powershell.exe';
  })();
  return shellPromise;
}

async function powershell(code) {
  // Missing processes are normal after a reboot. Explicit exit 0 prevents a
  // suppressed Get-Process miss from leaking PowerShell's failure exit status.
  const script = `[Console]::OutputEncoding = [Text.UTF8Encoding]::new(); $ProgressPreference = 'SilentlyContinue'; $ErrorActionPreference = 'Stop'; ${code}; exit 0`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  try {
    const result = await run(await powershellPath(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024 });
    return result.stdout.trim();
  } catch (error) {
    // EncodedCommand is implementation detail, not a useful diagnostic.
    const detail = String(error.stderr || '').replace(/#< CLIXML[\s\S]*/, '').trim();
    throw new Error(`Не удалось проверить/остановить локальный процесс${error.killed ? ': PowerShell не ответил за 15 секунд' : detail ? `: ${detail}` : '. Проверьте доступ к процессам Windows'}.`);
  }
}

async function processIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  const output = await powershell(`$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p) { @{ pid = $p.Id; started = $p.StartTime.ToUniversalTime().Ticks.ToString(); executable = $p.Path } | ConvertTo-Json -Compress }`);
  if (!output) return null;
  const identity = JSON.parse(output);
  if (!identity.started || !identity.executable) throw new Error(`Не удалось подтвердить владельца процесса ${pid}.`);
  return identity;
}

function sameProcess(expected, actual) {
  return expected && actual && expected.pid === actual.pid && expected.started === actual.started
    && normalized(expected.executable) === normalized(actual.executable);
}

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

async function saveState() {
  await writeFile(`${statePath}.tmp`, JSON.stringify(state, null, 2), 'utf8');
  await rename(`${statePath}.tmp`, statePath);
}

async function loadState() {
  const saved = await readJson(statePath, { version: 1, root });
  if (saved.version !== 1 || typeof saved.root !== 'string' || normalized(saved.root) !== normalized(root)) {
    throw new Error('Файл состояния принадлежит другому проекту или версии скрипта.');
  }
  return saved;
}

async function acquireLock() {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const lock = await open(lockPath, 'wx');
      try {
        const owner = await processIdentity(process.pid);
        if (!owner) throw new Error('Не удалось подтвердить процесс локального запуска.');
        await lock.writeFile(JSON.stringify(owner));
        return lock;
      } catch (error) { await lock.close(); await unlink(lockPath); throw error; }
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let owner;
      try { owner = await readJson(lockPath, null); }
      catch { throw new Error('Другой запуск/остановка ещё выполняется (.local/services.lock).'); }
      if (!owner || !owner.pid || !owner.started || sameProcess(owner, await processIdentity(owner.pid))) {
        throw new Error('Другой запуск/остановка ещё выполняется (.local/services.lock).');
      }
      // Only remove a stale lock whose recorded process no longer exists.
      await unlink(lockPath);
    }
  }
  throw new Error('Не удалось занять блокировку локальных сервисов.');
}

function configuredPath(value, label) {
  if (typeof value !== 'string' || !isAbsolute(value)) throw new Error(`${label} должен быть абсолютным путём в .local/postgres.json.`);
  return resolve(value);
}

async function databaseConfig() {
  const config = await readJson(join(local, 'postgres.json'), null);
  if (!config) return null;
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535 || config.host !== '127.0.0.1') throw new Error('Укажите host 127.0.0.1 и корректный port в .local/postgres.json.');
  const binDir = configuredPath(config.binDir, 'binDir');
  const dataDir = configuredPath(config.dataDir, 'dataDir');
  const logFile = configuredPath(config.logFile, 'logFile');
  const pgCtl = join(binDir, 'pg_ctl.exe');
  const postgres = join(binDir, 'postgres.exe');
  await access(pgCtl);
  await access(join(dataDir, 'PG_VERSION'));
  return { ...config, binDir, dataDir, logFile, pgCtl, postgres };
}

async function databaseIdentity(config) {
  let lines;
  try { lines = (await readFile(join(config.dataDir, 'postmaster.pid'), 'utf8')).split(/\r?\n/); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const pid = Number(lines[0]);
  const identity = await processIdentity(pid);
  if (!identity) return null;
  if (normalized(lines[1]) !== normalized(config.dataDir) || Number(lines[3]) !== config.port
    || normalized(identity.executable) !== normalized(config.postgres)) {
    throw new Error('Процесс PostgreSQL не соответствует локальному каталогу данных; операция отменена.');
  }
  // PostgreSQL records Unix start time in seconds; also reject a reused PID.
  const startedUnix = (BigInt(identity.started) - 621355968000000000n) / 10000000n;
  if (Math.abs(Number(startedUnix) - Number(lines[2])) > 10) throw new Error('PID PostgreSQL был переиспользован; операция отменена.');
  return identity;
}

async function portOpen(host, port) {
  return new Promise((resolvePromise, reject) => {
    const socket = createConnection({ host, port });
    socket.setTimeout(1500);
    socket.once('connect', () => { socket.destroy(); resolvePromise(true); });
    socket.once('timeout', () => { socket.destroy(); reject(new Error(`Проверка ${host}:${port} превысила время ожидания.`)); });
    socket.once('error', error => {
      socket.destroy();
      if (['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH'].includes(error.code)) resolvePromise(false);
      else reject(error);
    });
  });
}

async function assertFree(port) {
  for (const host of ['127.0.0.1', '::1']) {
    if (await portOpen(host, port)) throw new Error(`Порт ${port} уже занят процессом вне управления Klan. Существующий процесс не остановлен.`);
  }
}

async function ready(url, check, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (response.ok && await check(response)) return;
    } catch { /* A newly spawned service needs time to listen. */ }
    await delay(300);
  }
  throw new Error(`Сервис не готов: ${url}. Проверьте журналы в .local.`);
}

async function startDatabase(config) {
  const existing = await databaseIdentity(config);
  if (!existing) {
    await assertFree(config.port);
    await run(config.pgCtl, ['-D', config.dataDir, '-l', config.logFile, '-w', '-t', '30', 'start'], { windowsHide: true, timeout: 35000 });
  }
  const identity = await databaseIdentity(config);
  if (!identity || !await portOpen(config.host, config.port)) throw new Error('PostgreSQL не подтвердил готовность.');
  // Use an existing, verified cluster, but never adopt ownership of its process.
  if (!existing || sameProcess(state.database, identity)) {
    state.database = { ...identity, dataDir: config.dataDir };
    await saveState();
  }
  console.log(`PostgreSQL: 127.0.0.1:${config.port} (PID ${identity.pid}${existing && !sameProcess(state.database, identity) ? ', внешний процесс; не будет остановлен' : ''})`);
}

async function spawnService(name, entry, args, cwd, env, port, url, check) {
  const previous = state[name];
  if (previous && sameProcess(previous, await processIdentity(previous.pid))) {
    await ready(url, check, 5000);
    console.log(`${name}: ${url} (уже запущен, PID ${previous.pid})`);
    return;
  }
  delete state[name];
  await assertFree(port);
  const stdout = await open(join(local, `${name}.log`), 'a');
  const stderr = await open(join(local, `${name}-error.log`), 'a');
  let child;
  let recorded = false;
  try {
    child = spawn(process.execPath, args, { cwd, env, detached: true, windowsHide: true, stdio: ['ignore', stdout.fd, stderr.fd] });
    await new Promise((resolvePromise, reject) => { child.once('spawn', resolvePromise); child.once('error', reject); });
    child.unref();
    const identity = await processIdentity(child.pid);
    if (!identity || child.exitCode !== null || normalized(identity.executable) !== normalized(process.execPath)) throw new Error(`${name} завершился при запуске. Проверьте .local/${name}-error.log.`);
    state[name] = { ...identity, entry, cwd, port, url };
    await saveState();
    recorded = true;
  } catch (error) {
    // This handle was created by this invocation; never kill a PID found on a port.
    if (child && !recorded && child.exitCode === null) child.kill();
    if (!recorded) delete state[name];
    throw error;
  } finally {
    await stdout.close();
    await stderr.close();
  }
  await ready(url, check);
  console.log(`${name}: ${url} (PID ${child.pid})`);
}

async function start() {
  const backendEnv = resolve(root, process.env.DOTENV_CONFIG_PATH || '.env');
  const fileEnv = parse(await readFile(backendEnv, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; }));
  const env = { NODE_ENV: 'development', ...fileEnv, ...process.env, DOTENV_CONFIG_PATH: backendEnv };
  if (env.NODE_ENV === 'production') throw new Error('Локальный launcher предназначен для разработки; для production используйте npm start, Docker или systemd.');
  const port = Number(env.PORT || 3001);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT должен быть числом от 1 до 65535.');
  const databaseUrl = env.DEMO_MODE === 'true' ? env.DEMO_DATABASE_URL : env.DATABASE_URL;
  if (!databaseUrl && env.DEMO_MODE !== 'true') throw new Error('Задайте DATABASE_URL в .env. Для изолированного демо явно укажите DEMO_MODE=true.');
  const config = databaseUrl ? await databaseConfig() : null;
  if (config) {
    let database;
    try { database = new URL(databaseUrl); } catch { throw new Error('Некорректный URL базы в .env.'); }
    if (!['postgres:', 'postgresql:'].includes(database.protocol) || !['127.0.0.1', 'localhost'].includes(database.hostname)
      || Number(database.port || 5432) !== config.port) throw new Error('URL базы не соответствует .local/postgres.json; уберите локальную конфигурацию PostgreSQL для внешней базы.');
    if (env.DEMO_MODE === 'true' && database.pathname !== '/klan_demo') throw new Error('DEMO_DATABASE_URL должен использовать изолированную базу klan_demo.');
  }
  const apiEntry = join(root, 'src', 'server.ts');
  await access(apiEntry);
  await access(join(root, 'node_modules', 'tsx', 'package.json'));
  if (config) await startDatabase(config);
  await spawnService('api', apiEntry, ['--import', 'tsx', apiEntry], root, env,
    port, `http://127.0.0.1:${port}/api/health`, async response => (await response.json()).data?.status === 'ok');
}

async function stopService(name) {
  const expected = state[name];
  if (!expected) { console.log(`${name}: нет процесса, запущенного этими скриптами`); return; }
  const actual = await processIdentity(expected.pid);
  if (actual && !sameProcess(expected, actual)) throw new Error(`${name}: PID ${expected.pid} принадлежит другому процессу; он не остановлен.`);
  if (actual) {
    // Re-check identity inside the same PowerShell operation that stops the process.
    await powershell(`$p = Get-Process -Id ${expected.pid} -ErrorAction SilentlyContinue; if ($p) { if ($p.StartTime.ToUniversalTime().Ticks.ToString() -ne ${psQuote(expected.started)} -or $p.Path -ne ${psQuote(expected.executable)}) { throw 'Process identity changed; refusing to stop.' }; Stop-Process -InputObject $p -ErrorAction Stop; if (-not $p.WaitForExit(10000)) { throw 'Process did not stop within 10 seconds.' } }`);
  }
  delete state[name];
  await saveState();
  console.log(`${name}: остановлен`);
}

async function stop() {
  await stopService('api');
  if (!state.database) { console.log('PostgreSQL: нет процесса под управлением этих скриптов'); return; }
  const config = await databaseConfig();
  if (!config) throw new Error('Нельзя подтвердить управляемый PostgreSQL без .local/postgres.json; он не остановлен.');
  const actual = await databaseIdentity(config);
  if (actual && (!sameProcess(state.database, actual) || normalized(state.database.dataDir) !== normalized(config.dataDir))) throw new Error('PostgreSQL был запущен другим процессом; автоматическая остановка отменена.');
  if (actual) await run(config.pgCtl, ['-D', config.dataDir, '-m', 'fast', '-w', '-t', '30', 'stop'], { windowsHide: true, timeout: 35000 });
  delete state.database;
  await saveState();
  console.log('PostgreSQL: остановлен; данные сохранены');
}

async function status() {
  let unhealthy = false;
  for (const name of [...(state.database ? ['database'] : []), 'api']) {
    const expected = state[name];
    const running = expected && sameProcess(expected, await processIdentity(expected.pid));
    if (!running) {
      console.log(`${name}: остановлен (нет подтверждённого процесса)`);
      unhealthy = true;
      continue;
    }
    let healthy = false;
    try {
      if (name === 'database') {
        const config = await databaseConfig();
        if (!config || !sameProcess(expected, await databaseIdentity(config))) throw new Error('PostgreSQL identity changed.');
        // pg_isready localizes stdout; exit 0 is its stable readiness contract.
        await run(join(config.binDir, 'pg_isready.exe'), ['-h', config.host, '-p', String(config.port), '-t', '2'], { windowsHide: true, timeout: 5000 });
        healthy = true;
      } else {
        const response = await fetch(expected.url, { signal: AbortSignal.timeout(3000) });
        healthy = response.ok && (await response.json()).data?.status === 'ok';
      }
    } catch { /* Report an unhealthy process separately from a stopped one. */ }
    console.log(`${name}: ${healthy ? 'работает и отвечает' : 'процесс есть, проверка готовности не прошла'}, PID ${expected.pid}`);
    unhealthy ||= !healthy;
  }
  if (unhealthy) process.exitCode = 1;
}

async function main() {
  if (!['start', 'stop', 'status'].includes(action)) throw new Error('Используйте npm run local:start, npm run local:stop или npm run local:status.');
  if (process.platform !== 'win32') throw new Error('Эти скрипты предназначены для локального Windows-окружения. Для других ОС используйте Docker Compose.');
  await mkdir(local, { recursive: true });
  if (action === 'status') { state = await loadState(); await status(); return; }
  const lock = await acquireLock();
  try { state = await loadState(); await (action === 'start' ? start() : stop()); }
  finally { await lock.close(); await unlink(lockPath); }
}

main().catch(error => {
  console.error(error.message);
  if (action === 'start') console.error('Уже запущенные сервисы сохранены. Проверка: npm run local:status; остановка: npm run local:stop.');
  process.exitCode = 1;
});
