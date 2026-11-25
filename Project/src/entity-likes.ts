import type { Pool, PoolClient } from 'pg';
import type { Entity, LikeSummary, Resource } from './shared/contracts.js';
import { notFound } from './errors.js';

const enabled = new Set<Resource>(['feedback']);
export const likesEnabled = (resource: Resource) => enabled.has(resource);
export interface LikeChange {
  resource: Entity['type']; id: string; userId: string; liked: boolean; drafts: boolean;
}
export interface LikeRow { entityId: string; userId: string }

export const likeTables = `CREATE TABLE klan_entity_likes (
  entity_id text NOT NULL REFERENCES klan_entities(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES klan_users(id) ON DELETE CASCADE,
  PRIMARY KEY(entity_id, user_id)
);
CREATE INDEX klan_entity_likes_user ON klan_entity_likes(user_id)`;

export async function readLikeSummaries(db: Pool | PoolClient, ids: string[], viewer: string) {
  const result = await db.query<{id: string} & LikeSummary>(`SELECT entity_id AS id, count(*)::int AS count,
    bool_or(user_id=$2) AS liked FROM klan_entity_likes WHERE entity_id=ANY($1::text[]) GROUP BY entity_id`, [ids, viewer]);
  return new Map(result.rows.map(({id, count, liked}) => [id, {count, liked}]));
}

export async function writeLike(db: PoolClient, change: LikeChange): Promise<LikeSummary> {
  // Serialize competing votes on this entity. Read the total after the write in the same transaction.
  const target = await db.query<{id: string}>(`SELECT id FROM klan_entities WHERE kind=$1
    AND (id=$2 OR card->>'publicId'=$2) AND ($3 OR card->>'status' IS DISTINCT FROM 'draft') FOR UPDATE`,
    [change.resource, change.id, change.drafts]);
  const id = target.rows[0]?.id;
  if (!id) throw notFound();
  if (change.liked) await db.query('INSERT INTO klan_entity_likes(entity_id,user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [id, change.userId]);
  else await db.query('DELETE FROM klan_entity_likes WHERE entity_id=$1 AND user_id=$2', [id, change.userId]);
  return (await readLikeSummaries(db, [id], change.userId)).get(id) ?? {count: 0, liked: false};
}
