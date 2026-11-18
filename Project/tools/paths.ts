import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const backendRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = resolve(backendRoot, '..');

/** Personal reports belong in ignored .local or an explicitly chosen external directory. */
export function privateOutputPath(name: string): string {
  const target = resolve(backendRoot, name);
  const insideRepository = relative(repositoryRoot, target);
  if (insideRepository === '' || (!insideRepository.startsWith(`..${sep}`) && insideRepository !== '..' && !isAbsolute(insideRepository))) {
    const insidePrivate = relative(resolve(backendRoot, '.local'), target);
    if (!insidePrivate || insidePrivate === '..' || insidePrivate.startsWith(`..${sep}`) || isAbsolute(insidePrivate)) {
      throw new Error('Reports and backups must be inside Project/.local or an external directory');
    }
  } else if (!isAbsolute(name)) throw new Error('External report and backup paths must be absolute');
  return target;
}
