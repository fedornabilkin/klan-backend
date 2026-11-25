import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import pg from 'pg';
import { likeTables, readLikeSummaries, writeLike, type LikeChange } from './entity-likes.js';
import { MemoryRepository } from './repository.js';
import { createSeed } from './seed.js';

test('file repository retains likes on restart and removes them with a member or entity', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'klan-likes-'));
  t.after(() => rm(dir,{recursive:true,force:true}));
  const file = join(dir, 'data.json');
  let repo = await MemoryRepository.persistent(file, createSeed);
  const vote: LikeChange = {resource:'feedback',id:'feedback-1',userId:'user-1',liked:true,drafts:false};
  await repo.write(vote);
  await repo.write({...vote, userId:'user-2'});
  await repo.close();
  repo = await MemoryRepository.persistent(file, createSeed);
  const summary = async () => (await repo.likeSummaries([vote.id], vote.userId)).get(vote.id);
  assert.deepEqual(await summary(),{count:2,liked:true});
  await repo.write(state => { state.users = state.users.filter(u => u.id !== vote.userId); });
  assert.deepEqual(await summary(),{count:1,liked:false});
  await repo.write(state => { state.entities = state.entities.filter(e => e.id !== vote.id); });
  assert.equal(await summary(), undefined);
  await repo.close();
});

test('PostgreSQL stores one vote per user, checks visibility and cascades deletions', {skip: !process.env.TEST_DATABASE_URL}, async () => {
  const pool = new pg.Pool({connectionString:process.env.TEST_DATABASE_URL});
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query(`CREATE TEMP TABLE klan_users(id text PRIMARY KEY);
      CREATE TEMP TABLE klan_entities(id text PRIMARY KEY,kind text,card jsonb)`);
    await db.query(likeTables.replace('CREATE TABLE','CREATE TEMP TABLE'));
    await db.query(`INSERT INTO pg_temp.klan_users VALUES ('one'),('two');
      INSERT INTO pg_temp.klan_entities VALUES ('ticket','feedback','{"publicId":27,"status":"open"}'),
      ('draft','feedback','{"publicId":28,"status":"draft"}')`);
    const vote: LikeChange = {resource:'feedback',id:'27',userId:'one',liked:true,drafts:false};
    assert.deepEqual(await writeLike(db,vote), {count:1,liked:true});
    assert.deepEqual(await writeLike(db,{...vote,id:'ticket'}), {count:1,liked:true});
    assert.deepEqual(await writeLike(db,{...vote,userId:'two'}), {count:2,liked:true});
    await assert.rejects(writeLike(db,{...vote,id:'28'}),{status:404});
    assert.deepEqual(await writeLike(db,{...vote,id:'28',drafts:true}), {count:1,liked:true});
    assert.deepEqual(await writeLike(db,{...vote,liked:false}), {count:1,liked:false});
    assert.deepEqual((await readLikeSummaries(db,['ticket'],'two')).get('ticket'), {count:1,liked:true});
    await db.query("DELETE FROM pg_temp.klan_users WHERE id='two'");
    await db.query("DELETE FROM pg_temp.klan_entities WHERE id='draft'");
    assert.equal((await db.query('SELECT * FROM pg_temp.klan_entity_likes')).rowCount,0);
  } finally {
    try { await db.query('ROLLBACK'); } finally { db.release(); await pool.end(); }
  }
});
