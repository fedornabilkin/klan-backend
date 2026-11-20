import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

// Transfer only content-addressed registry packages used in production.
// npm still verifies the lockfile and installs them inside the target image.
const [lockfile, cache, output] = process.argv.slice(2);
const { packages } = JSON.parse(readFileSync(lockfile, 'utf8'));
const files = new Set();
for (const pkg of Object.values(packages)) {
  if (pkg.dev || !pkg.integrity?.startsWith('sha512-')) continue;
  const hash = Buffer.from(pkg.integrity.slice(7), 'base64').toString('hex');
  if (hash.length !== 128) continue;
  const file = `_cacache/content-v2/sha512/${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash.slice(4)}`;
  if (existsSync(join(cache, file))) files.add(file);
}
const archive = spawnSync('tar', ['--mtime=@0', '--owner=0', '--group=0', '--numeric-owner',
  '--mode=0644', '-czf', output, '-C', cache, '-T', '-'], {
  input: [...files].sort().join('\n'), stdio: ['pipe', 'inherit', 'inherit'],
});
if (archive.error) throw archive.error;
if (archive.status !== 0) process.exit(archive.status ?? 1);
console.log(`Packaged ${files.size} npm archives for the VPS build.`);
