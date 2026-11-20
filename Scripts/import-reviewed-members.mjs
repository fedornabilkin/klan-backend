import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const project = join(root, 'Project');
const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  apply: { type: 'boolean' }, local: { type: 'boolean' }, 'correction-only': { type: 'boolean' },
  key: { type: 'string' }, 'known-hosts': { type: 'string' },
} });
if (positionals.length !== 1) throw new Error('Укажите путь к JSON-плану. Для записи добавьте --apply.');
const apply = !!values.apply, local = !!values.local;
const plan = JSON.parse(readFileSync(resolve(positionals[0]), 'utf8').replace(/^\uFEFF/, ''));
const require = createRequire(join(project, 'package.json'));
const ts = require('typescript');
const worker = readFileSync(join(project, 'tools/importers/reviewed-members.ts'), 'utf8');
// The streamed module runs from the application root and uses the deployed backend's ID allocator.
const js = ts.transpileModule(worker, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } })
  .outputText.replace("from '../../src/user-ids.js'", "from './dist/user-ids.js'");
const encoded = Buffer.from(JSON.stringify(plan)).toString('base64');
const program = js + `
import { PostgresRepository } from './dist/repository.js';
let url;
try { url = new URL(process.env.${local ? 'DEMO_DATABASE_URL' : 'DATABASE_URL'}); }
catch { throw new Error('Неверный адрес базы в настройках приложения.'); }
if (!['postgres:', 'postgresql:'].includes(url.protocol) ||
    ${local ? "url.pathname !== '/klan_demo' || !['127.0.0.1','localhost','[::1]'].includes(url.hostname)" :
    "url.pathname !== '/klan' || url.hostname !== 'db' || process.env.NODE_ENV !== 'production' || process.env.DEMO_MODE !== 'false'"}) {
  throw new Error('Unexpected database environment');
}
const repo = new PostgresRepository(url.href);
try {
  const report = await importReviewedMembers(repo, JSON.parse(Buffer.from('${encoded}', 'base64').toString('utf8')), ${apply}, ${!!values['correction-only']});
  console.log('${apply ? 'Добавлено' : 'К добавлению'}: ' + report.added.length);
  for (const u of report.added) console.log('  ' + u.name + (u.callsign ? ' «' + u.callsign + '»' : ''));
  console.log('Уже были импортированы: ' + report.known.length);
  for (const u of report.review) console.log('Пропущено совпадение ФИО: ' + u.name + ' — ID ' + u.profileIds.join(', '));
  console.log('Профиль №' + report.publicId + ': ' + report.correctedName +
    (report.rename ? '${apply ? ' (исправлен)' : ' (будет исправлен)'}' : ' (уже исправлен)'));
  if (report.numbers) {
    for (const p of report.numbers.profiles) console.log(p.name + ': ' + (p.from === p.to ? '№' + p.to + ' (уже назначен)' : (p.from ? '№' + p.from : 'новый профиль') + ' → №' + p.to));
    console.log('Обновления сохранённых данных участников: ' + report.numbers.snapshots + ', ссылок: ' + report.numbers.links);
  }
} finally { await repo.close(); }
`;

function run(command, args) {
  const result = spawnSync(command, args, { cwd: project, input: program, stdio: ['pipe', 'inherit', 'inherit'], windowsHide: true });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
if (local) {
  if (!existsSync(join(project, 'dist/repository.js'))) throw new Error('Сначала выполните npm run build в backend/Project.');
  run(process.execPath, ['--import=dotenv/config', '--input-type=module', '-']);
} else {
  const key = resolve(values.key ?? join(homedir(), '.ssh', 'ablakin-bot-actions'));
  const hosts = resolve(values['known-hosts'] ?? join(homedir(), '.ssh', 'ablakin-bot-known-hosts'));
  if (!existsSync(key) || !existsSync(hosts)) throw new Error('Укажите SSH-ключ и файл проверенных хостов через --key и --known-hosts.');
  const shell = readFileSync(join(root, 'Deploy/import-reviewed-members.sh'), 'utf8').replaceAll('\r\n', '\n');
  const quote = s => "'" + s.replaceAll("'", "'\\''") + "'";
  run('ssh', ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-o', 'IdentitiesOnly=yes',
    '-o', 'StrictHostKeyChecking=yes', '-o', 'GlobalKnownHostsFile=none', '-o', 'UserKnownHostsFile="' + hosts.replaceAll('\\', '/') + '"',
    '-i', key, 'deploy@92.63.98.81', 'bash -c ' + quote(shell) + ' -- ' + (apply ? 'apply' : 'preview')]);
}
