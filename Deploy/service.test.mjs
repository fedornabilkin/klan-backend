import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const deployDirectory = dirname(fileURLToPath(import.meta.url));
const projectDirectory = resolve(deployDirectory, '..', 'Project');
const requireProject = createRequire(join(projectDirectory, 'package.json'));
const bash = process.env.DEPLOY_TEST_BASH || (process.platform === 'win32'
  ? 'C:/Program Files/Git/bin/bash.exe'
  : 'bash');
const probe = spawnSync(bash, ['--version'], { encoding: 'utf8' });
const unavailable = probe.status !== 0
  ? 'Bash is unavailable; run on Linux or allow Git Bash to start on Windows'
  : false;

function shellPath(value) {
  const absolute = resolve(value).replaceAll('\\', '/');
  return process.platform === 'win32'
    ? absolute.replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`)
    : absolute;
}

function write(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, { mode: 0o700 });
}

function runtime(overrides = {}) {
  const password = "p$a#s'word";
  const values = {
    NODE_ENV: 'production', APP_ORIGIN: 'https://klan.example.test', DEMO_MODE: 'false',
    POSTGRES_DB: 'klan_test', POSTGRES_USER: 'test_user', POSTGRES_PASSWORD: password,
    DATABASE_URL: `postgresql://test_user:${encodeURIComponent(password)}@db:5432/klan_test`,
    TELEGRAM_GROUP_IDS: '-12345', BOT_INTERNAL_SECRET: 'x'.repeat(40),
    ...overrides,
  };
  return Object.entries(values).filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${value}`).join('\n') + '\n';
}

function harness(context, contents = runtime()) {
  const temporary = mkdtempSync(join(tmpdir(), 'klan-backend-hooks-test-'));
  context.after(() => rmSync(temporary, { recursive: true, force: true }));
  const root = join(temporary, 'backend');
  const release = join(root, 'releases', 'synthetic-release');
  const bin = join(temporary, 'bin');
  const log = join(temporary, 'calls.log');
  const runner = join(temporary, 'run.sh');
  const composeNode = join(temporary, 'compose-node.mjs');
  write(join(release, 'runtime.env'), contents);
  write(join(bin, 'curl'), '#!/usr/bin/env bash\nprintf "curl:%s\\n" "$*" >> "$TEST_LOG"\n[[ "$FAIL_HEALTH" != yes ]]\n');
  write(join(bin, 'docker'), `#!/usr/bin/env bash
printf 'docker:%s\\n' "$*" >> "$TEST_LOG"
case "$*" in
  'pull postgres:16-bookworm') exit 0 ;;
  'image inspect postgres:16-bookworm') [[ "$FAIL_LOCAL_DB_IMAGE" != yes ]] ;;
  *) printf 'Unexpected Docker operation\\n' >&2; exit 98 ;;
esac
`);
  // Execute the exact embedded Node preflight with the application's actual readConfig.
  // Only the import path changes: source+tsx replaces the image's compiled dist module.
  write(composeNode, `import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
const nodeArguments = args.slice(args.indexOf('node') + 1);
const expression = nodeArguments.indexOf('-e') + 1;
nodeArguments[expression] = nodeArguments[expression].replace('./dist/config.js', process.env.TEST_CONFIG_URI);
const runtime = Object.fromEntries(readFileSync('runtime.env', 'utf8').split(/\\r?\\n/)
  .filter(line => line && !line.startsWith('#'))
  .map(line => { const equals = line.indexOf('='); return [line.slice(0, equals), line.slice(equals + 1)]; }));
const result = spawnSync(process.execPath, ['--import', process.env.TEST_TSX_URI, ...nodeArguments],
  { env: { ...process.env, ...runtime }, encoding: 'utf8' });
process.stdout.write(result.stdout || '');
process.stderr.write(result.stderr || '');
process.exit(result.status ?? 99);
`);
  write(runner, `#!/usr/bin/env bash
set -euo pipefail
export PATH="$TEST_BIN:$PATH"
release_dir="$TEST_RELEASE"
deploy_root="$TEST_ROOT"
operation="$TEST_OPERATION"
cd "$release_dir"
compose() {
  printf '%s\\n' "$*" >> "$TEST_LOG"
  case "$1" in
    config) test -f "$release_dir/database.env" ;;
    run) node "$TEST_COMPOSE_NODE" "$@" ;;
    up) return 0 ;;
    exec)
      if [[ "$FAIL_BACKUP" == yes ]]; then printf 'partial'; return 1; fi
      printf 'synthetic-pg-dump'
      ;;
    stop) return 0 ;;
    *) printf 'Unexpected compose operation\\n' >&2; return 98 ;;
  esac
}
source "$TEST_SERVICE"
"$1"
`);
  return {
    root,
    release,
    lines: () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [],
    run: (operation, extra = {}) => spawnSync(bash, [shellPath(runner), operation], {
      env: {
        ...process.env,
        TEST_BIN: shellPath(bin), TEST_LOG: shellPath(log),
        TEST_RELEASE: shellPath(release), TEST_ROOT: shellPath(root),
        TEST_COMPOSE_NODE: shellPath(composeNode),
        TEST_SERVICE: shellPath(join(deployDirectory, 'service.sh')),
        TEST_CONFIG_URI: pathToFileURL(join(projectDirectory, 'src', 'config.ts')).href,
        TEST_TSX_URI: pathToFileURL(requireProject.resolve('tsx')).href,
        TEST_OPERATION: 'deploy', FAIL_BACKUP: '', FAIL_HEALTH: '', FAIL_LOCAL_DB_IMAGE: '', ...extra,
      },
      encoding: 'utf8', timeout: 15_000,
    }),
  };
}

test('preflight writes only PostgreSQL settings and accepts raw special characters', { skip: unavailable }, (context) => {
  const fixture = harness(context);
  const result = fixture.run('service_preflight');
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.equal(readFileSync(join(fixture.release, 'database.env'), 'utf8'),
    "POSTGRES_DB=klan_test\nPOSTGRES_USER=test_user\nPOSTGRES_PASSWORD=p$a#s'word\n");
  assert.equal(fixture.lines()[0], 'config --quiet');
  assert.equal(fixture.lines()[1], 'docker:image inspect postgres:16-bookworm');
  assert.doesNotMatch(result.stdout + result.stderr, /synthetic-token|p\$a#s/);
});

test('missing, empty or duplicate database settings fail before any Compose operation', { skip: unavailable }, (context) => {
  for (const contents of [
    runtime({ POSTGRES_PASSWORD: undefined }),
    runtime({ POSTGRES_PASSWORD: '' }),
    runtime() + 'POSTGRES_USER=duplicate\n',
  ]) {
    const fixture = harness(context, contents);
    const result = fixture.run('service_preflight');
    assert.notEqual(result.status, 0);
    assert.deepEqual(fixture.lines(), []);
  }
});

test('the embedded configuration check rejects mismatched database host, user, password, name and port', { skip: unavailable }, (context) => {
  for (const databaseUrl of [
    `postgresql://test_user:${encodeURIComponent("p$a#s'word")}@other:5432/klan_test`,
    `postgresql://other:${encodeURIComponent("p$a#s'word")}@db:5432/klan_test`,
    'postgresql://test_user:wrong@db:5432/klan_test',
    `postgresql://test_user:${encodeURIComponent("p$a#s'word")}@db:5432/other`,
    `postgresql://test_user:${encodeURIComponent("p$a#s'word")}@db:6543/klan_test`,
  ]) {
    const fixture = harness(context, runtime({ DATABASE_URL: databaseUrl }));
    const result = fixture.run('service_preflight');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Invalid production configuration or mismatched database credentials/);
    assert.ok(!fixture.lines().some((line) => line.startsWith('up ') || line.startsWith('exec ')));
  }
});

test('application configuration is validated before activation', { skip: unavailable }, (context) => {
  const fixture = harness(context, runtime({ APP_ORIGIN: 'http://klan.example.test' }));
  const result = fixture.run('service_preflight');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Invalid production configuration/);
  assert.ok(!fixture.lines().some((line) => line.startsWith('up ')));
});

test('manual rollback uses only the local PostgreSQL image and never contacts a registry', { skip: unavailable }, (context) => {
  const fixture = harness(context);
  const result = fixture.run('service_preflight', { TEST_OPERATION: 'rollback' });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.equal(fixture.lines()[1], 'docker:image inspect postgres:16-bookworm');
  assert.ok(!fixture.lines().some((line) => /pull|login/.test(line)));

  const missing = harness(context);
  const failed = missing.run('service_preflight', { TEST_OPERATION: 'rollback', FAIL_LOCAL_DB_IMAGE: 'yes' });
  assert.notEqual(failed.status, 0);
  assert.deepEqual(missing.lines(), ['config --quiet', 'docker:image inspect postgres:16-bookworm']);
});

test('a failed PostgreSQL backup removes its partial file and never updates the API', { skip: unavailable }, (context) => {
  const fixture = harness(context);
  const result = fixture.run('service_prepare_data', { FAIL_BACKUP: 'yes' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Database backup failed; API was not updated/);
  assert.equal(fixture.lines()[0], 'up -d --no-build --wait --wait-timeout 180 db');
  assert.match(fixture.lines()[1], /^exec -T db sh -c pg_dump/);
  assert.equal(fixture.lines().length, 2);
  assert.deepEqual(readdirSync(join(fixture.root, 'backups')), []);
});

test('a successful backup is retained before the API is replaced', { skip: unavailable }, (context) => {
  const fixture = harness(context);
  const preparation = fixture.run('service_prepare_data');
  assert.equal(preparation.status, 0, preparation.stderr || preparation.error?.message);
  const result = fixture.run('service_start');
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  const lines = fixture.lines();
  assert.equal(lines.length, 3);
  assert.equal(lines[0], 'up -d --no-build --wait --wait-timeout 180 db');
  assert.match(lines[1], /^exec -T db sh -c pg_dump/);
  assert.equal(lines[2], 'up -d --no-build --wait --wait-timeout 180 api');
  const backups = readdirSync(join(fixture.root, 'backups'));
  assert.equal(backups.length, 1);
  assert.equal(readFileSync(join(fixture.root, 'backups', backups[0]), 'utf8'), 'synthetic-pg-dump');
});

test('stopping a failed API preserves the database container and persistent volume', { skip: unavailable }, (context) => {
  const fixture = harness(context);
  const result = fixture.run('service_stop');
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.deepEqual(fixture.lines(), ['stop --timeout 20 api']);
});

test('a failed local health check propagates to the release orchestrator', { skip: unavailable }, (context) => {
  const fixture = harness(context);
  const result = fixture.run('service_verify', { FAIL_HEALTH: 'yes' });
  assert.notEqual(result.status, 0);
  assert.deepEqual(fixture.lines(), ['curl:--fail --silent --show-error --max-time 10 http://127.0.0.1:3101/api/health']);
});
