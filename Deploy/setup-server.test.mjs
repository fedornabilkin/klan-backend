import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const directory = dirname(fileURLToPath(import.meta.url));
const bash = process.env.DEPLOY_TEST_BASH || (process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash');
const unavailable = spawnSync(bash, ['--version']).status !== 0 ? 'Bash is unavailable' : false;
const token = '123456:synthetic_bot_token_1234567890';
const domain = 'community.example.test';
const existingSecret = 'existing$"\'`#literal\\$(not-a-command)=value';

function shellPath(path) {
  const absolute = resolve(path).replaceAll('\\', '/');
  return process.platform === 'win32' ? absolute.replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`) : absolute;
}

function fixture(context) {
  const root = mkdtempSync(join(tmpdir(), 'klan-setup-cli-'));
  context.after(() => {
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
    rmSync(root, { recursive: true, force: true });
  });
  const bin = join(root, 'bin');
  const log = join(root, 'calls.log');
  const path = (relative) => join(root, relative);
  const write = (relative, content) => {
    mkdirSync(dirname(path(relative)), { recursive: true });
    writeFileSync(path(relative), content, { mode: 0o700 });
  };
  const command = (name, body) => write(`bin/${name}`, `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`);
  const record = 'printf "%s:%s\\n" "$(basename "$0")" "$*" >> "$TEST_LOG"';
  command('id', 'if [[ "${1:-}" == -gn ]]; then printf "%s\\n" "$2"; fi');
  command('runuser', 'while [[ "$1" != -- ]]; do shift; done; shift; exec "$@"');
  command('install', `
${record}
target="\${!#}"
[[ "$target" == "$TEST_ROOT/"* ]] || exit 90
mode=0700
while (( $# )); do
  case "$1" in -m) mode=$2; shift 2;; -o|-g) shift 2;; *) shift;; esac
done
mkdir -p -- "$target"
chmod "$mode" "$target"
`);
  command('docker', `
${record}
[[ "\${TEST_WITHOUT_DOCKER:-}" != yes ]] || exit 91
case "$1 \${2:-}" in
  'compose version') printf '2.30.0\\n';;
  'info ') :;;
  'network inspect') test -f "$TEST_ROOT/network";;
  'network create') printf created > "$TEST_ROOT/network";;
  'volume inspect')
    volume="\${!#}"
    test -d "$TEST_ROOT/volumes/$volume"
    if [[ "\${3:-}" == --format ]]; then printf '%s\\n' "$TEST_ROOT/volumes/$volume"; fi;;
  'volume create') mkdir -p -- "$TEST_ROOT/volumes/$3";;
  *) printf 'Unexpected Docker operation\\n' >&2; exit 92;;
esac
`);
  command('openssl', `
${record}
[[ "$*" == 'rand -hex 32' ]] || exit 93
count=0
[[ ! -f "$TEST_ROOT/random-count" ]] || count=$(cat "$TEST_ROOT/random-count")
count=$((count + 1)); printf '%s' "$count" > "$TEST_ROOT/random-count"
if (( count == 1 )); then printf '%064d\\n' 1; else printf '%064d\\n' 2; fi
`);
  command('ip', `${record}\nprintf '2: eth0 inet 10.23.0.8/24 brd 10.23.0.255 scope global eth0\\n'`);
  command('uname', "printf 'x86_64\\n'");
  for (const name of ['curl', 'nginx', 'certbot', 'rsync', 'dpkg', 'flock']) command(name, record);
  command('apt-get', "printf 'Unexpected package installation\\n' >&2; exit 94");
  mkdirSync(path('run'), { recursive: true });

  let source = readFileSync(join(directory, 'setup-server.sh'), 'utf8').replaceAll('\r\n', '\n');
  const nginxCall = '    setup_frontend_nginx\n';
  assert.equal(source.split(nginxCall).length, 2, 'Expected the single frontend handler call');
  source = source.replace(nginxCall, '    fixture_frontend_nginx\n');
  for (const systemPath of ['/opt/klan', '/var/www/klan', '/run/klan-setup.lock', '/etc/letsencrypt', '/etc/ssh/ssh_host_']) {
    source = source.replaceAll(systemPath, `${shellPath(root)}${systemPath}`);
  }
  source = source.replaceAll('[[ $EUID == 0 ]]', '[[ "$TEST_ROOT" != "" ]]');
  source = `fixture_frontend_nginx() {
  printf 'nginx:configured\\n' >> "$TEST_LOG"
  mkdir -p -- "$TEST_ROOT/etc/letsencrypt/live/$site_domain"
  printf 'synthetic-certificate' > "$TEST_ROOT/etc/letsencrypt/live/$site_domain/fullchain.pem"
}
${source}`;
  write('setup-server.sh', source);

  return {
    path, write,
    exists: (relative) => existsSync(path(relative)),
    read: (relative) => readFileSync(path(relative), 'utf8'),
    calls: () => existsSync(log) ? readFileSync(log, 'utf8') : '',
    run: (role, answers = [], extra = {}) => spawnSync(bash, [
      '-c', 'export PATH="$TEST_BIN:$PATH"; exec bash "$@"', 'test', shellPath(path('setup-server.sh')), role,
    ], {
      env: { ...process.env, TEST_BIN: shellPath(bin), TEST_ROOT: shellPath(root), TEST_LOG: shellPath(log), ...extra },
      input: answers.join('\n') + '\n', encoding: 'utf8', timeout: 30_000,
    }),
  };
}

function successful(result, secrets = [token]) {
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  for (const secret of secrets) assert.ok(!(result.stdout + result.stderr).includes(secret), 'A supplied secret reached output');
}

test('all provisions three components and repeats without replacing credentials or existing data', { skip: unavailable }, (context) => {
  const setup = fixture(context);
  successful(setup.run('all', [domain, token, 'Klan_Test_Bot', '-1234567', '', 'ops@example.test']));
  const backend = setup.read('opt/klan/backend/shared/runtime.env');
  const bot = setup.read('opt/klan/bot/shared/runtime.env');
  const value = (text, key) => text.split('\n').find((line) => line.startsWith(key + '='))?.slice(key.length + 1);
  assert.equal(value(backend, 'TELEGRAM_BOT_TOKEN'), token);
  assert.equal(value(bot, 'TELEGRAM_BOT_TOKEN'), token);
  assert.equal(value(backend, 'BOT_INTERNAL_SECRET'), value(bot, 'BOT_BACKEND_SECRET'));
  assert.notEqual(value(backend, 'POSTGRES_PASSWORD'), value(backend, 'BOT_INTERNAL_SECRET'));
  assert.equal(value(bot, 'BOT_BACKEND_URL'), 'http://api:3001');
  assert.equal(setup.read('opt/klan/frontend/shared/site-domain'), domain + '\n');
  assert.ok(setup.exists('var/www/klan'));
  setup.write('volumes/klan-production-postgres/PG_VERSION', '16');
  successful(setup.run('all', ['']));
  assert.equal(setup.read('opt/klan/backend/shared/runtime.env'), backend);
  assert.equal(setup.read('opt/klan/bot/shared/runtime.env'), bot);
  assert.equal(setup.read('volumes/klan-production-postgres/PG_VERSION'), '16');
  assert.equal(setup.read('random-count'), '2');
});

test('bot-only asks for the existing API secret and accepts a private remote origin', { skip: unavailable }, (context) => {
  const setup = fixture(context);
  const result = setup.run('bot', [token, existingSecret, 'http://10.23.0.8:3101']);
  successful(result, [token, existingSecret]);
  assert.match(result.stderr, /Действующий BOT_INTERNAL_SECRET/);
  assert.equal(setup.read('opt/klan/bot/shared/runtime.env'), `TELEGRAM_BOT_TOKEN=${token}\nBOT_BACKEND_SECRET=${existingSecret}\nBOT_BACKEND_URL=http://10.23.0.8:3101\n`);
  assert.ok(setup.exists('volumes/klan-production-bot-state'));
  assert.equal(setup.exists('opt/klan/backend'), false);
  assert.equal(setup.exists('opt/klan/frontend'), false);
  assert.equal(setup.exists('volumes/klan-production-postgres'), false);
  assert.doesNotMatch(setup.calls(), /openssl:/);
  const repeated = setup.run('bot', ['']);
  successful(repeated, [token, existingSecret]);
  assert.doesNotMatch(repeated.stderr, /ввод скрыт/);
  assert.match(setup.read('opt/klan/bot/shared/runtime.env'), /^BOT_BACKEND_URL=http:\/\/10\.23\.0\.8:3101$/m);
});

test('a fresh standalone bot requires an explicit API address', { skip: unavailable }, (context) => {
  const setup = fixture(context);
  const result = setup.run('bot', [token, existingSecret, '']);
  assert.notEqual(result.status, 0);
  assert.equal(setup.exists('opt/klan/bot/shared/runtime.env'), false);
  for (const secret of [token, existingSecret]) assert.ok(!(result.stdout + result.stderr).includes(secret));
});

test('an existing PostgreSQL volume without saved credentials is protected before prompting for new secrets', { skip: unavailable }, (context) => {
  const setup = fixture(context);
  setup.write('volumes/klan-production-postgres/PG_VERSION', '16');
  const result = setup.run('backend', [domain]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /У базы уже есть данные/);
  assert.doesNotMatch(result.stderr, /Токен Telegram/);
  assert.equal(setup.read('volumes/klan-production-postgres/PG_VERSION'), '16');
  assert.equal(setup.exists('opt/klan/backend/shared/runtime.env'), false);
  assert.doesNotMatch(setup.calls(), /openssl:/);
});

test('frontend-only configures its origin without Docker or Telegram settings', { skip: unavailable }, (context) => {
  const setup = fixture(context);
  successful(setup.run('frontend', [domain, 'https://api.internal.example.test', 'ops@example.test'], { TEST_WITHOUT_DOCKER: 'yes' }));
  assert.equal(setup.read('opt/klan/frontend/shared/api-upstream'), 'https://api.internal.example.test\n');
  assert.equal(setup.exists('opt/klan/backend'), false);
  assert.equal(setup.exists('opt/klan/bot'), false);
  assert.doesNotMatch(setup.calls(), /docker:|openssl:/);
});

test('backend-only creates API settings and verifies its assigned private bind address', { skip: unavailable }, (context) => {
  const setup = fixture(context);
  successful(setup.run('backend', [domain, token, 'Klan_Test_Bot', '-1234567', '', '10.23.0.8']));
  assert.equal(setup.read('opt/klan/backend/shared/api-bind-address'), '10.23.0.8\n');
  assert.match(setup.read('opt/klan/backend/shared/runtime.env'), /^APP_ORIGIN=https:\/\/community\.example\.test$/m);
  assert.ok(setup.exists('volumes/klan-production-postgres'));
  assert.equal(setup.exists('volumes/klan-production-bot-state'), false);
  assert.equal(setup.exists('opt/klan/frontend'), false);
  assert.equal(setup.exists('opt/klan/bot'), false);
});
