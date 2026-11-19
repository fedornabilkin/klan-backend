import type { PoolClient } from 'pg';
import { accessForLevel } from './access.js';

const confirmedFedorId = '364484915';
const firstLoginHandle = 'edhalilov';

export function isDeploymentAdmin(id: string | undefined, bindings: Record<string,string> = {}): boolean {
  return !!id && (id === confirmedFedorId || bindings[firstLoginHandle] === id);
}

/** Called only inside the transaction accepting a verified private bot callback. */
export function bindDeploymentAdmin(bindings: Record<string,string>, id: string, telegramUsername?: string) {
  if (id !== confirmedFedorId && telegramUsername?.toLowerCase() === firstLoginHandle) {
    bindings[firstLoginHandle] ??= id;
  }
  return isDeploymentAdmin(id, bindings);
}

/** Reconcile only linked accounts, on each production start before the health check succeeds. */
export async function reconcileDeploymentAdmins(db: PoolClient) {
  await db.query('BEGIN');
  try {
    await db.query('SELECT pg_advisory_xact_lock(54652602)');
    const pinned = await db.query("SELECT data #>> '{}' AS id FROM klan_auth WHERE kind='managedAdmins' AND id=$1", [firstLoginHandle]);
    const ids = [confirmedFedorId, ...pinned.rows.map(row => row.id as string)];
    const access = JSON.stringify(accessForLevel('admin','telegram'));
    const updated = await db.query(`UPDATE klan_users u SET data=u.data || jsonb_build_object('role','admin','access',$2::jsonb)
      FROM klan_auth t WHERE t.kind='telegramUsers' AND t.id=ANY($1::text[]) AND u.id=t.data #>> '{}'
      AND (u.data->>'role' IS DISTINCT FROM 'admin' OR u.data->'access' IS DISTINCT FROM $2::jsonb)`, [ids, access]);
    await db.query('COMMIT');
    return { updated: updated.rowCount ?? 0, awaitingEdhalilov: !pinned.rowCount };
  } catch (error) { await db.query('ROLLBACK'); throw error; }
}
