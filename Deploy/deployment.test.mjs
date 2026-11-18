import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// The real transport and server scripts run against disposable files and command doubles.
// No Docker daemon, SSH connection, registry, Telegram token or application database is used.
const deployDirectory = dirname(fileURLToPath(import.meta.url));
const bash = process.env.DEPLOY_TEST_BASH || (process.platform === 'win32'
  ? 'C:/Program Files/Git/bin/bash.exe'
  : 'bash');
const bashEnvironment = { ...process.env, MSYS: 'winsymlinks:lnk' };
const probe = spawnSync(bash, ['--version'], { env: bashEnvironment, encoding: 'utf8' });
const unavailable = probe.status !== 0
  ? 'Bash is unavailable; run on Linux or allow Git Bash to start on Windows'
  : false;
const oldId = `${'a'.repeat(40)}-1-1`;

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

function harness(context, { previous = true } = {}) {
  const temporary = mkdtempSync(join(tmpdir(), 'klan-deployment-test-'));
  context.after(() => rmSync(temporary, { recursive: true, force: true }));
  const root = join(temporary, 'klan', 'backend');
  const bin = join(temporary, 'bin');
  const log = join(temporary, 'calls.log');
  const source = join(temporary, 'source');
  const environment = {
    ...bashEnvironment,
    TEST_BIN: shellPath(bin),
    TEST_LOG: shellPath(log),
    TEST_SOURCE: shellPath(source), TEST_IMAGE_MARKER: shellPath(join(temporary, 'image-built')),
    FAIL_PREFLIGHT: '', FAIL_START: '', FAIL_VERIFY: '', FAIL_STOP: '', FAIL_BUILD: '',
    FAIL_PREPARE: '', ADVANCE_MAIN: '', REUSE_IMAGE: '',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
  };
  write(join(bin, 'docker'), `#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == 'compose version --short' ]]; then printf '2.30.0\\n'; exit 0; fi
if [[ "$1" == image && "$2" == inspect ]]; then
  if [[ "$*" == *--format* ]]; then printf '%s\\n' "$TEST_SOURCE_SHA"; exit 0; fi
  if [[ "$*" == *"klan-backend:$TEST_SOURCE_SHA" && ! -f "$TEST_IMAGE_MARKER-$TEST_SOURCE_SHA" && "$REUSE_IMAGE" != yes ]]; then exit 1; fi
  exit 0
fi
if [[ "$1" == build ]]; then
  [[ ! -v KLAN_GIT_TOKEN ]] || { printf 'Git token leaked to build\\n' >&2; exit 97; }
  printf 'docker:build\\n' >> "$TEST_LOG"
  [[ "$FAIL_BUILD" != yes ]] || exit 1
  touch "$TEST_IMAGE_MARKER-$TEST_SOURCE_SHA"
  if [[ "$ADVANCE_MAIN" == yes ]]; then git -C "$TEST_SOURCE" -c user.name=Test -c user.email=test@example.test commit --allow-empty -m 'Newer commit' >/dev/null; fi
  exit 0
fi
if [[ "$1" == compose ]]; then printf 'docker:config\\n' >> "$TEST_LOG"; exit 0; fi
printf 'Unexpected mocked Docker command\\n' >&2; exit 98
`);
  for (const command of ['flock', 'curl']) write(join(bin, command), '#!/usr/bin/env bash\nexit 0\n');
  write(join(bin, 'ssh'), '#!/usr/bin/env bash\nprintf "unexpected:ssh\\n" >> "$TEST_LOG"\nexit 99\n');
  const service = `#!/usr/bin/env bash
record_hook() { printf '%s:%s\\n' "$1" "$(cat "$release_dir/fixture-name")" >> "$TEST_LOG"; }
service_preflight() { record_hook preflight; [[ "$FAIL_PREFLIGHT" != "$(cat "$release_dir/fixture-name")" ]]; }
service_prepare_data() { [[ "$FAIL_PREPARE" != "$(cat "$release_dir/fixture-name")" ]]; }
service_start() { record_hook start; [[ "$FAIL_START" != "$(cat "$release_dir/fixture-name")" ]]; }
service_verify() { record_hook verify; [[ "$FAIL_VERIFY" != "$(cat "$release_dir/fixture-name")" ]]; }
service_stop() { record_hook stop; [[ "$FAIL_STOP" != "$(cat "$release_dir/fixture-name")" ]]; }
`;
  const server = readFileSync(join(deployDirectory, 'server-release.sh'), 'utf8')
    .replaceAll('/opt/klan/', `${shellPath(temporary)}/klan/`)
    .replace('https://github.com/fedornabilkin/klan-backend.git', `'${shellPath(source)}'`);
  for (const [id, label, digest] of [[oldId, 'old', 'c']]) {
    const release = join(root, 'releases', id);
    write(join(release, 'Deploy', 'server-release.sh'), server);
    write(join(release, 'Deploy', 'service.sh'), service);
    write(join(release, 'Docker', 'compose.production.yaml'), 'services: {}\n');
    write(join(release, 'runtime.env'), 'SYNTHETIC_CONFIGURATION=only\n');
    write(join(release, 'image-ref'), `ghcr.io/example/klan-backend@sha256:${digest.repeat(64)}\n`);
    write(join(release, 'fixture-name'), label);
  }
  write(join(source, 'Deploy', 'server-release.sh'), server);
  write(join(source, 'Deploy', 'service.sh'), service);
  write(join(source, 'Docker', 'compose.production.yaml'), 'services: {}\n');
  write(join(source, 'Docker', 'Dockerfile'), 'FROM scratch\n');
  write(join(source, 'fixture-name'), 'new');
  write(join(source, 'tracked-source'), 'This file must come from git archive.\n');
  shell('git init -b main "$1" >/dev/null && git -C "$1" add . && git -C "$1" -c user.name=Test -c user.email=test@example.test commit -m Initial >/dev/null', [shellPath(source)]);
  const sourceSha = shell('git -C "$1" rev-parse HEAD', [shellPath(source)]);
  const newId = `${sourceSha}-2-1`;
  environment.TEST_SOURCE_SHA = sourceSha;
  const incoming = join(root, 'incoming', newId);
  write(join(incoming, 'Deploy', 'server-release.sh'), server);
  write(join(incoming, 'commit'), `${sourceSha}\n`);
  write(join(incoming, 'runtime.env'), 'SYNTHETIC_CONFIGURATION=only\n');
  function command(script, args = [], extra = {}, input = '') {
    return spawnSync(bash, ['-c', 'export PATH="$TEST_BIN:$PATH"; exec bash "$@"', 'test', shellPath(script), ...args], {
      env: { ...environment, ...extra }, input, encoding: 'utf8', timeout: 15_000,
    });
  }
  function shell(code, args = []) {
    const result = spawnSync(bash, ['-c', code, 'test', ...args], {
      env: environment, encoding: 'utf8', timeout: 15_000,
    });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    return result.stdout.trim();
  }
  function link(name, id) {
    shell('ln -s -- "$1" "$2"; test -L "$2"', [`releases/${id}`, shellPath(join(root, name))]);
  }
  if (previous) link('current', oldId);
  return {
    root,
    newId,
    sourceSha,
    incoming,
    git: (args) => shell('git "$@"', args),
    nextDeploy: () => {
      shell('git -C "$1" -c user.name=Test -c user.email=test@example.test commit --allow-empty -m Next >/dev/null', [shellPath(source)]);
      const sha = shell('git -C "$1" rev-parse HEAD', [shellPath(source)]);
      const id = `${sha}-3-1`;
      const next = join(root, 'incoming', id);
      write(join(next, 'Deploy', 'server-release.sh'), server);
      write(join(next, 'commit'), `${sha}\n`);
      write(join(next, 'runtime.env'), 'SYNTHETIC_CONFIGURATION=next\n');
      const result = command(join(next, 'Deploy', 'server-release.sh'), ['deploy'], { TEST_SOURCE_SHA: sha }, 'fake-short-lived-token\n');
      return { id, sha, result };
    },
    log: () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [],
    hooks: () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [])
      .filter((line) => /^(preflight|start|verify|stop):/.test(line)),
    current: () => shell('if test -L "$1"; then readlink "$1"; fi', [shellPath(join(root, 'current'))]),
    previous: () => shell('if test -L "$1"; then readlink "$1"; fi', [shellPath(join(root, 'previous'))]),
    link,
    command,
    deploy: (extra = {}) => command(join(incoming, 'Deploy', 'server-release.sh'), ['deploy'], extra, 'fake-short-lived-token\n'),
    rollback: (extra = {}) => command(join(root, 'releases', oldId, 'Deploy', 'server-release.sh'), ['rollback'], extra),
  };
}

const transportEnvironment = {
  DEPLOY_HOST: 'server.example.test', DEPLOY_PORT: '22', DEPLOY_USER: 'deploy',
  DEPLOY_SSH_KEY: 'synthetic-key', DEPLOY_KNOWN_HOSTS: 'synthetic-host-key',
  PRODUCTION_ENV: 'EXAMPLE=value',
  GITHUB_SHA: 'b'.repeat(40), GITHUB_RUN_ID: '2', GITHUB_RUN_ATTEMPT: '1',
  GIT_TOKEN: 'synthetic-token',
};

for (const [setting, value, expected] of [
  ['DEPLOY_HOST', "host'; touch /tmp/forbidden", 'Invalid SSH host'],
  ['DEPLOY_PORT', '0', 'Invalid SSH port'],
  ['DEPLOY_PORT', '65536', 'Invalid SSH port'],
  ['DEPLOY_USER', 'user;command', 'Invalid SSH user'],
  ['GITHUB_SHA', 'main', 'Invalid commit'],
  ['GITHUB_RUN_ID', '../2', 'Invalid run'],
  ['GIT_TOKEN', '', 'Missing setting: GIT_TOKEN'],
  ['PRODUCTION_ENV', '', 'Missing setting: PRODUCTION_ENV'],
]) {
  test(`transport rejects ${setting}=${JSON.stringify(value)} before SSH`, { skip: unavailable }, (context) => {
    const fixture = harness(context);
    const result = fixture.command(join(deployDirectory, 'deploy.sh'), [], { ...transportEnvironment, [setting]: value });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, new RegExp(expected));
    assert.deepEqual(fixture.log(), []);
  });
}

test('successful deployment publishes current and retains the previous release', { skip: unavailable }, (context) => {
  const fixture = harness(context);
  const result = fixture.deploy();
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.equal(fixture.current(), `releases/${fixture.newId}`);
  assert.equal(fixture.previous(), `releases/${oldId}`);
  assert.deepEqual(fixture.hooks(), ['preflight:new', 'start:new', 'verify:new']);
  assert.doesNotMatch(result.stdout + result.stderr, /fake-short-lived-token/);
  assert.equal(readFileSync(join(fixture.root, 'releases', fixture.newId, 'tracked-source'), 'utf8'), 'This file must come from git archive.\n');
  assert.equal(existsSync(join(fixture.incoming, 'runtime.env')), false);
});

for (const [failure, hooks] of [
  ['FAIL_PREFLIGHT', ['preflight:new']],
  ['FAIL_BUILD', []],
]) {
  test(`${failure} keeps the current release running without attempting rollback`, { skip: unavailable }, (context) => {
    const fixture = harness(context);
    const result = fixture.deploy({ [failure]: failure === 'FAIL_BUILD' ? 'yes' : 'new' });
    assert.notEqual(result.status, 0);
    assert.equal(fixture.current(), `releases/${oldId}`);
    assert.equal(fixture.previous(), '');
    assert.deepEqual(fixture.hooks(), hooks);
  });
}

for (const failure of ['FAIL_START', 'FAIL_VERIFY']) {
  test(`${failure} stops the failed service and restores the old release`, { skip: unavailable }, (context) => {
    const fixture = harness(context);
    const result = fixture.deploy({ [failure]: 'new' });
    assert.notEqual(result.status, 0);
    assert.equal(fixture.current(), `releases/${oldId}`);
    assert.equal(fixture.previous(), '');
    const expected = ['preflight:new', 'start:new'];
    if (failure === 'FAIL_VERIFY') expected.push('verify:new');
    assert.deepEqual(fixture.hooks(), [...expected, 'stop:new', 'start:old', 'verify:old']);
    assert.match(result.stderr, /Previous release restored/);
  });
}

test('a failed first deployment stops the service and does not publish current', { skip: unavailable }, (context) => {
  const fixture = harness(context, { previous: false });
  const result = fixture.deploy({ FAIL_VERIFY: 'new' });
  assert.notEqual(result.status, 0);
  assert.equal(fixture.current(), '');
  assert.equal(fixture.previous(), '');
  assert.deepEqual(fixture.hooks(), ['preflight:new', 'start:new', 'verify:new', 'stop:new']);
  assert.match(result.stderr, /First deployment failed; service stopped/);
  assert.ok(existsSync(join(fixture.root, 'releases', fixture.newId, 'runtime.env')));
});

test('failed rollback is reported and cannot turn a failed deployment into success', { skip: unavailable }, (context) => {
  const fixture = harness(context);
  const result = fixture.deploy({ FAIL_VERIFY: 'new', FAIL_START: 'old' });
  assert.notEqual(result.status, 0);
  assert.equal(fixture.current(), `releases/${oldId}`);
  assert.deepEqual(fixture.hooks(), ['preflight:new', 'start:new', 'verify:new', 'stop:new', 'start:old']);
  assert.match(result.stderr, /ROLLBACK FAILED/);
});

test('if the failed service cannot stop, rollback never starts a second worker', { skip: unavailable }, (context) => {
  const fixture = harness(context);
  const result = fixture.deploy({ FAIL_VERIFY: 'new', FAIL_STOP: 'new' });
  assert.notEqual(result.status, 0);
  assert.equal(fixture.current(), `releases/${oldId}`);
  assert.deepEqual(fixture.hooks(), ['preflight:new', 'start:new', 'verify:new', 'stop:new']);
  assert.match(result.stderr, /automatic rollback was not started/);
});

test('manual rollback uses the saved release and environment, then swaps current and previous', { skip: unavailable }, (context) => {
  const fixture = harness(context);
  assert.equal(fixture.deploy().status, 0);
  const before = fixture.hooks().length;
  const result = fixture.rollback();
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.equal(fixture.current(), `releases/${oldId}`);
  assert.equal(fixture.previous(), `releases/${fixture.newId}`);
  assert.deepEqual(fixture.hooks().slice(before), ['preflight:old', 'start:old', 'verify:old']);
  assert.equal(fixture.log().filter((entry) => entry === 'docker:build').length, 1);
  assert.ok(!fixture.log().some((entry) => /docker:(login|pull)/.test(entry)));
});

test('manual rollback without a saved previous release leaves the active service untouched', { skip: unavailable }, (context) => {
  const fixture = harness(context);
  const result = fixture.rollback();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /No previous release/);
  assert.equal(fixture.current(), `releases/${oldId}`);
  assert.deepEqual(fixture.hooks(), []);
});

test('runtime configuration is treated as data rather than sourced shell code', { skip: unavailable }, (context) => {
  const fixture = harness(context);
  const marker = join(fixture.root, 'must-not-exist');
  write(join(fixture.incoming, 'runtime.env'), `EXAMPLE=$(touch '${shellPath(marker)}')\n`);
  const result = fixture.deploy();
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.equal(existsSync(marker), false);
});

test('a failed data backup leaves the previous API running without a stop or restart', { skip: unavailable }, (context) => {
  const fixture = harness(context);
  const result = fixture.deploy({ FAIL_PREPARE: 'new' });
  assert.notEqual(result.status, 0);
  assert.equal(fixture.current(), `releases/${oldId}`);
  assert.deepEqual(fixture.hooks(), ['preflight:new']);
  assert.doesNotMatch(result.stderr, /Restoring the previous release/);
});

test('a newer main during the build prevents activation', { skip: unavailable }, (context) => {
  const fixture = harness(context);
  const result = fixture.deploy({ ADVANCE_MAIN: 'yes' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /main has changed/);
  assert.equal(fixture.current(), `releases/${oldId}`);
  assert.deepEqual(fixture.hooks(), ['preflight:new']);
});

test('an existing correctly labelled local API image skips the server build', { skip: unavailable }, (context) => {
  const fixture = harness(context);
  const result = fixture.deploy({ REUSE_IMAGE: 'yes' });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.ok(!fixture.log().includes('docker:build'));
});

test('successive real Git fetches retain main history in the bare cache and archive each commit', { skip: unavailable }, (context) => {
  const fixture = harness(context);
  const first = fixture.deploy();
  assert.equal(first.status, 0, first.stderr);
  const next = fixture.nextDeploy();
  assert.equal(next.result.status, 0, next.result.stderr);
  assert.equal(fixture.current(), `releases/${next.id}`);
  assert.equal(fixture.previous(), `releases/${fixture.newId}`);
  const repository = `--git-dir=${shellPath(join(fixture.root, 'repository.git'))}`;
  assert.equal(fixture.git([repository, 'rev-parse', 'refs/remotes/origin/main']), next.sha);
  assert.equal(fixture.git([repository, 'rev-parse', 'refs/remotes/origin/main^']), fixture.sourceSha);
  assert.equal(fixture.git([repository, 'rev-list', '--count', 'refs/remotes/origin/main']), '2');
  assert.doesNotMatch(readFileSync(join(fixture.root, 'repository.git', 'config'), 'utf8'), /fake-short-lived-token/);
});
