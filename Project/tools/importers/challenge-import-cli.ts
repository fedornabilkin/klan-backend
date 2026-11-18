import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { backendRoot, privateOutputPath } from '../paths.js';
import { config as loadEnv } from 'dotenv';
import { PostgresRepository } from '../../src/repository.js';
import { planHistoricalChallengeImport, HistoricalChallengeImportError } from './challenge-import.js';

function parseArguments(argv: string[]) {
  const values = new Set(['--file', '--database-env', '--report', '--backup-file', '--source-file']);
  const args: Record<string, string | boolean> = {};
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--apply') { args[arg] = true; continue; }
    if (!values.has(arg) || !argv[index + 1] || argv[index + 1].startsWith('--')) throw new Error(`Unknown or incomplete argument: ${arg}`);
    args[arg] = argv[++index];
  }
  if (!['DEMO_DATABASE_URL', 'DATABASE_URL'].includes(String(args['--database-env']))) throw new Error('Choose --database-env DEMO_DATABASE_URL or DATABASE_URL explicitly');
  if (!args['--file']) throw new Error('Choose --file <reviewed-manifest.json> explicitly');
  if (args['--apply'] && !args['--backup-file']) throw new Error('--apply requires --backup-file .local/backups/<unique-name>.json (or an external absolute path)');
  return args;
}
async function writeJson(path: string, value: unknown, exclusive = false) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', flag: exclusive ? 'wx' : 'w' });
}
async function main() {
  const args = parseArguments(process.argv.slice(2));
  const root = backendRoot;
  loadEnv({ path: resolve(root, process.env.DOTENV_CONFIG_PATH || '.env'), quiet: true });
  const manifestFile = resolve(root, String(args['--file']));
  const reportFile = privateOutputPath(String(args['--report'] ?? '.local/imports/challenge-import-report.json'));
  const backupFile = args['--backup-file'] ? privateOutputPath(String(args['--backup-file'])) : undefined;
  const bytes = await readFile(manifestFile), manifest = JSON.parse(bytes.toString('utf8'));
  if (args['--source-file']) {
    const source = await readFile(resolve(root, String(args['--source-file'])));
    if (createHash('sha256').update(source).digest('hex') !== manifest.sourceHash) throw new Error('Source file hash differs from the reviewed manifest');
  }
  const databaseEnv = String(args['--database-env']);
  const connection = process.env[databaseEnv];
  if (!connection) throw new Error(`${databaseEnv} is not configured`);
  let database: string;
  try { database = new URL(connection).pathname.replace(/^\//, ''); } catch { throw new Error(`${databaseEnv} is not a valid database URL`); }
  const options = { importedAt: new Date().toISOString() };
  const metadata = { database, databaseEnv, manifestFile: basename(manifestFile), manifestFileHash: createHash('sha256').update(bytes).digest('hex'), sourceHash: manifest.sourceHash, importedAt: options.importedAt };
  const repo = new PostgresRepository(connection);
  try {
    // Migrations and authentication are deliberately outside this local import.
    const apply = Boolean(args['--apply']);
    const report = apply ? await repo.write(async state => {
      const plan = planHistoricalChallengeImport(state, manifest, options);
      await writeJson(reportFile, { mode: 'pre-apply', ...metadata, ...plan.report });
      if (plan.report.changed) {
        // The snapshot is taken under the same repository lock as the import.
        // Existing backup files cause an error and roll back the transaction.
        await writeJson(backupFile!, { format: 'klan-database-state-v1', database, createdAt: options.importedAt, state }, true);
        Object.assign(state, plan.state);
      }
      return plan.report;
    }) : await repo.read(state => planHistoricalChallengeImport(state, manifest, options).report);
    await writeJson(reportFile, { mode: apply ? 'applied' : 'dry-run', ...metadata, ...report });
    const { decisions: _decisions, teams: _teams, ...summary } = report;
    console.log(JSON.stringify({ mode: apply ? 'applied' : 'dry-run', database, reportFile, ...(apply && report.changed ? { backupFile } : {}), ...summary }, null, 2));
  } finally { await repo.close(); }
}
main().catch(error => {
  console.error(error instanceof HistoricalChallengeImportError ? `${error.code}: ${error.message}` : error instanceof Error ? error.message : 'Import failed');
  process.exitCode = 1;
});
