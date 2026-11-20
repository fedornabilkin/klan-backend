import type { Request, Response } from 'express';
import { promisify } from 'node:util';
import { brotliCompress, constants, gzip } from 'node:zlib';
import type { Repository } from './repository.js';

const compress = promisify(gzip);
const brotli = promisify(brotliCompress);
type Body = { json: string; gzip?: Promise<Buffer>; br?: Promise<Buffer> };
type Entry = { expires: number; body: Promise<Body>; id?: string };
type PageKey = 'tags' | 'tag-usage' | 'items' | 'geography' | `${'stats' | 'dashboard' | 'dashboard-cards' | 'challenge'}-${'all' | 'published'}`;

/** Called after authentication. Only the fixed, shared views can occupy cache slots. */
export function pageResponses(repo: Repository) {
  const entries = new Map<PageKey, Entry>();
  let revision = repo.revision;
  return async (req: Request, res: Response, key: PageKey | undefined, load: () => Promise<unknown>, id?: string) => {
    if (repo.revision === undefined || !key) {
      res.json({ data: await load() });
      return;
    }
    if (revision !== repo.revision) {
      entries.clear();
      revision = repo.revision;
    }
    let entry = entries.get(key);
    if (!entry || entry.expires <= Date.now() || entry.id !== id) {
      const body = load().then(data => {
        const json = JSON.stringify({ data });
        const maxBytes = id === undefined ? 512 * 1024 : 1024 * 1024;
        if (Buffer.byteLength(json) > maxBytes && entries.get(key)?.body === body) entries.delete(key);
        return { json };
      }).catch(error => {
        if (entries.get(key)?.body === body) entries.delete(key);
        throw error;
      });
      entry = { body, expires: Date.now() + 10_000, id };
      entries.set(key, entry);
    }
    const body = await entry.body;
    res.type('json').vary('Accept-Encoding');
    const encoding = body.json.length >= 1024 && req.headers['accept-encoding'] && req.acceptsEncodings('gzip', 'br', 'identity');
    if (encoding === 'gzip' || encoding === 'br') {
      body[encoding] ??= (encoding === 'gzip' ? compress(body.json, { level: 1 }) :
        brotli(body.json, { params: { [constants.BROTLI_PARAM_QUALITY]: 2 } })).catch(error => { delete body[encoding]; throw error; });
      res.set('Content-Encoding', encoding).send(await body[encoding]);
    } else {
      res.send(body.json);
    }
  };
}
