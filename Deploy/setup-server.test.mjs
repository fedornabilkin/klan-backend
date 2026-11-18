import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
  command('runuser', 'export TEST_RUN_AS="$2"; while [[ "$1" != -- ]]; do shift; done; shift; exec "$@"');
  command('install', `
${record}
target="\${!#}"
[[ "$target" == "$TEST_ROOT/"* ]] || exit 90
mode=0700 owner='' group=''
while (( $# )); do
  case "$1" in -m) mode=$2; shift 2;; -o) owner=$2; shift 2;; -g) group=$2; shift 2;; *) shift;; esac
done
printf 'directory:%s:%s:%s:%s\\n' "$owner" "$group" "$mode" "\${target#"$TEST_ROOT/"}" >> "$TEST_LOG"
mkdir -p -- "$target"
chmod "$mode" "$target"
`);
  command('docker', `
${record}
[[ "\${TEST_WITHOUT_DOCKER:-}" != yes ]] || exit 91
if [[ "\${TEST_OFFLINE:-}" == yes && ( "$1" == network || "$1" == volume ) ]]; then
  [[ "\${TEST_RUN_AS:-}" == deploy ]] || { echo 'Docker resources must belong to the deploy user daemon' >&2; exit 95; }
fi
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
  for (const name of ['apt-get', 'gh', 'ssh', 'systemctl']) command(name, record + '\nexit 94');
  mkdirSync(path('run'), { recursive: true });

  function readFixtureScript(name) {
    let source = readFileSync(join(directory, name), 'utf8').replaceAll('\r\n', '\n');
    for (const systemPath of ['/opt/klan', '/var/www/klan', '/run/klan-setup.lock', '/etc/letsencrypt', '/etc/ssh/ssh_host_']) {
      source = source.replaceAll(systemPath, `${shellPath(root)}${systemPath}`);
    }
    return source.replaceAll('[[ $EUID == 0 ]]', '[[ "$TEST_ROOT" != "" ]]');
  }
  write('setup-server.sh', readFixtureScript('setup-server.sh'));

  function writeDeploymentScript() {
    const source = readFixtureScript('setup-deployment.sh');
    const nginxCall = '    setup_frontend_nginx\n';
    assert.equal(source.split(nginxCall).length, 2, 'Expected the single frontend handler call');
    write('setup-deployment.sh', `fixture_frontend_nginx() {
  printf 'nginx:configured\\n' >> "$TEST_LOG"
  mkdir -p -- "$TEST_ROOT/etc/letsencrypt/live/$site_domain"
  printf 'synthetic-certificate' > "$TEST_ROOT/etc/letsencrypt/live/$site_domain/fullchain.pem"
}
${source.replace(nginxCall, '    fixture_frontend_nginx\n')}`);
  }

  const run = (name, args, answers, extra) => spawnSync(bash, [
    '-c', 'export PATH="$TEST_BIN:$PATH"; exec bash "$@"', 'test', shellPath(path(name)), ...args,
  ], {
    env: { ...process.env, TEST_BIN: shellPath(bin), TEST_ROOT: shellPath(root), TEST_LOG: shellPath(log), ...extra },
    input: answers.map((answer) => answer + '\n').join(''), encoding: 'utf8', timeout: 30_000,
  });
  return {
    path, write,
    exists: (relative) => existsSync(path(relative)),
    read: (relative) => readFileSync(path(relative), 'utf8'),
    calls: () => existsSync(log) ? readFileSync(log, 'utf8') : '',
    prepare: (args = [], extra = {}) => run('setup-server.sh', args, [], { ...extra, TEST_OFFLINE: 'yes' }),
    configure: (role, answers, extra = {}) => {
      writeDeploymentScript();
      return run('setup-deployment.sh', ['configure-domain', role], answers, extra);
    },
  };
}

function successful(result, secrets = [token]) {
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  for (const secret of secrets) assert.ok(!(result.stdout + result.stderr).includes(secret), 'A supplied secret reached output');
}

test('server preparation exposes only component selection', { skip: unavailable }, (context) => {
  const setup = fixture(context);
  const help = setup.prepare(['--help']);
  successful(help);
  assert.match(help.stdout, /all\|frontend\|backend\|bot/);
  for (const formerMode of ['configure-domain', 'github']) {
    assert.equal(setup.prepare([formerMode]).status, 2);
  }
  assert.equal(setup.calls(), '');
});

test('default preparation allocates all server resources offline and preserves the installed data on repeat', { skip: unavailable }, (context) => {
  const setup = fixture(context);
  successful(setup.prepare());
  const directoryCalls = setup.calls().split('\n');
  function checkDirectory(path, owner, mode) {
    assert.ok(setup.exists(path), path);
    assert.ok(directoryCalls.includes(`directory:${owner}:${owner}:${mode}:${path}`), path);
  }
  checkDirectory('opt/klan', 'root', '0755');
  checkDirectory('var/www/klan', 'deploy', '0755');
  for (const role of ['frontend', 'backend', 'bot']) {
    for (const suffix of ['', '/releases', '/shared']) checkDirectory(`opt/klan/${role}${suffix}`, 'deploy', '0700');
  }
  for (const path of ['frontend/incoming', 'backend/incoming', 'backend/backups']) checkDirectory(`opt/klan/${path}`, 'deploy', '0700');
  assert.ok(setup.exists('network'));
  assert.ok(setup.exists('volumes/klan-production-postgres'));
  assert.ok(setup.exists('volumes/klan-production-bot-state'));
  for (const path of ['backend/shared/runtime.env', 'bot/shared/runtime.env', 'frontend/shared/site-domain', 'frontend/shared/api-upstream']) {
    assert.equal(setup.exists('opt/klan/' + path), false, path);
  }

  const release = 'opt/klan/backend/releases/old';
  const data = {
    [release + '/runtime.env']: 'SAVED_RELEASE=value\n',
    'opt/klan/bot/shared/runtime.env': 'keep this file verbatim\n',
    'var/www/klan/index.html': 'existing site',
    'volumes/klan-production-postgres/PG_VERSION': '16',
    'volumes/klan-production-bot-state/offset.json': '{"offset":42}',
  };
  for (const [path, value] of Object.entries(data)) setup.write(path, value);
  symlinkSync(setup.path(release), setup.path('opt/klan/backend/current'), process.platform === 'win32' ? 'junction' : 'dir');
  successful(setup.prepare(['all']));
  for (const [path, value] of Object.entries(data)) assert.equal(setup.read(path), value, path);
  assert.equal(setup.exists('opt/klan/backend/shared/runtime.env'), false, 'Preparation must leave release snapshots alone');
  assert.doesNotMatch(setup.calls(), /^(gh|ssh|apt-get|nginx|certbot|systemctl|curl|openssl):/m);
  assert.equal(setup.calls().split('\n').filter((line) => line.startsWith('docker:network create')).length, 1);
  assert.equal(setup.calls().split('\n').filter((line) => line.startsWith('docker:volume create')).length, 2);
});

for (const role of ['frontend', 'backend', 'bot']) {
  test(`offline ${role} preparation only creates resources for the selected component`, { skip: unavailable }, (context) => {
    const setup = fixture(context);
    successful(setup.prepare([role], role === 'frontend' ? { TEST_WITHOUT_DOCKER: 'yes' } : {}));
    for (const component of ['frontend', 'backend', 'bot']) {
      assert.equal(setup.exists('opt/klan/' + component), component === role);
    }
    assert.equal(setup.exists('var/www/klan'), role === 'frontend');
    assert.equal(setup.exists('network'), role !== 'frontend');
    assert.equal(setup.exists('volumes/klan-production-postgres'), role === 'backend');
    assert.equal(setup.exists('volumes/klan-production-bot-state'), role === 'bot');
    if (role === 'frontend') assert.doesNotMatch(setup.calls(), /^docker:/m);
  });
}

test('domain configuration provisions three components and repeats without replacing credentials or existing data', { skip: unavailable }, (context) => {
  const setup = fixture(context);
  successful(setup.configure('all', [domain, token, 'Klan_Test_Bot', '-1234567', '', 'ops@example.test']));
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
  successful(setup.configure('all', ['']));
  assert.equal(setup.read('opt/klan/backend/shared/runtime.env'), backend);
  assert.equal(setup.read('opt/klan/bot/shared/runtime.env'), bot);
  assert.equal(setup.read('volumes/klan-production-postgres/PG_VERSION'), '16');
  assert.equal(setup.read('random-count'), '2');
});

test('bot-only asks for the existing API secret and accepts a private remote origin', { skip: unavailable }, (context) => {
  const setup = fixture(context);
  const result = setup.configure('bot', [token, existingSecret, 'http://10.23.0.8:3101']);
  successful(result, [token, existingSecret]);
  assert.match(result.stderr, /Действующий BOT_INTERNAL_SECRET/);
  assert.equal(setup.read('opt/klan/bot/shared/runtime.env'), `TELEGRAM_BOT_TOKEN=${token}\nBOT_BACKEND_SECRET=${existingSecret}\nBOT_BACKEND_URL=http://10.23.0.8:3101\n`);
  assert.ok(setup.exists('volumes/klan-production-bot-state'));
  assert.equal(setup.exists('opt/klan/backend'), false);
  assert.equal(setup.exists('opt/klan/frontend'), false);
  assert.equal(setup.exists('volumes/klan-production-postgres'), false);
  assert.doesNotMatch(setup.calls(), /openssl:/);
  const repeated = setup.configure('bot', ['']);
  successful(repeated, [token, existingSecret]);
  assert.doesNotMatch(repeated.stderr, /ввод скрыт/);
  assert.match(setup.read('opt/klan/bot/shared/runtime.env'), /^BOT_BACKEND_URL=http:\/\/10\.23\.0\.8:3101$/m);
});

test('a fresh standalone bot requires an explicit API address', { skip: unavailable }, (context) => {
  const setup = fixture(context);
  const result = setup.configure('bot', [token, existingSecret, '']);
  assert.notEqual(result.status, 0);
  assert.equal(setup.exists('opt/klan/bot/shared/runtime.env'), false);
  for (const secret of [token, existingSecret]) assert.ok(!(result.stdout + result.stderr).includes(secret));
});

test('an existing PostgreSQL volume without saved credentials is protected before prompting for new secrets', { skip: unavailable }, (context) => {
  const setup = fixture(context);
  setup.write('volumes/klan-production-postgres/PG_VERSION', '16');
  const result = setup.configure('backend', [domain]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /У базы уже есть данные/);
  assert.doesNotMatch(result.stderr, /Токен Telegram/);
  assert.equal(setup.read('volumes/klan-production-postgres/PG_VERSION'), '16');
  assert.equal(setup.exists('opt/klan/backend/shared/runtime.env'), false);
  assert.doesNotMatch(setup.calls(), /openssl:/);
});

test('frontend-only configures its origin without Docker or Telegram settings', { skip: unavailable }, (context) => {
  const setup = fixture(context);
  successful(setup.configure('frontend', [domain, 'https://api.internal.example.test', 'ops@example.test'], { TEST_WITHOUT_DOCKER: 'yes' }));
  assert.equal(setup.read('opt/klan/frontend/shared/api-upstream'), 'https://api.internal.example.test\n');
  assert.equal(setup.exists('opt/klan/backend'), false);
  assert.equal(setup.exists('opt/klan/bot'), false);
  assert.doesNotMatch(setup.calls(), /docker:|openssl:/);
});

test('backend-only creates API settings and verifies its assigned private bind address', { skip: unavailable }, (context) => {
  const setup = fixture(context);
  successful(setup.configure('backend', [domain, token, 'Klan_Test_Bot', '-1234567', '', '10.23.0.8']));
  assert.equal(setup.read('opt/klan/backend/shared/api-bind-address'), '10.23.0.8\n');
  assert.match(setup.read('opt/klan/backend/shared/runtime.env'), /^APP_ORIGIN=https:\/\/community\.example\.test$/m);
  assert.ok(setup.exists('volumes/klan-production-postgres'));
  assert.equal(setup.exists('volumes/klan-production-bot-state'), false);
  assert.equal(setup.exists('opt/klan/frontend'), false);
  assert.equal(setup.exists('opt/klan/bot'), false);
});
