import type { Request, Response } from 'express';
import { promisify } from 'node:util';
import { gzip } from 'node:zlib';
import type { Repository } from './repository.js';

const compress = promisify(gzip);
type Body = { json: string; gzip?: Promise<Buffer> };
type Entry = { expires: number; body: Promise<Body> };
type PageKey = 'tags' | 'tag-usage' | 'items' | 'geography' | `${'stats' | 'dashboard' | 'dashboard-cards'}-${'all' | 'published'}`;

/** Called after authentication. Only the fixed, shared views can occupy cache slots. */
export function pageResponses(repo: Repository) {
  const entries = new Map<PageKey, Entry>();
  let revision = repo.revision;
  return async (req: Request, res: Response, key: PageKey | undefined, load: () => Promise<unknown>) => {
    if (repo.revision === undefined || !key) {
      res.json({ data: await load() });
      return;
    }
    if (revision !== repo.revision) {
      entries.clear();
      revision = repo.revision;
    }
    let entry = entries.get(key);
    if (!entry || entry.expires <= Date.now()) {
      const body = load().then(data => {
        const json = JSON.stringify({ data });
        if (Buffer.byteLength(json) > 512 * 1024 && entries.get(key)?.body === body) entries.delete(key);
        return { json };
      }).catch(error => {
        if (entries.get(key)?.body === body) entries.delete(key);
        throw error;
      });
      entry = { body, expires: Date.now() + 10_000 };
      entries.set(key, entry);
    }
    const body = await entry.body;
    res.type('json').vary('Accept-Encoding');
    if (body.json.length >= 1024 && req.headers['accept-encoding'] && req.acceptsEncodings('gzip', 'br', 'identity') === 'gzip') {
      body.gzip ??= compress(body.json, { level: 1 }).catch(error => { delete body.gzip; throw error; });
      const bytes = await body.gzip;
      res.set('Content-Encoding', 'gzip').send(bytes);
    } else {
      res.send(body.json);
    }
  };
}
