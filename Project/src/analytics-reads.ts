import type { PoolClient } from 'pg';
import { emptyState } from './repository.js';
import type { Entity, User } from './shared/contracts.js';
import { notFound } from './errors.js';

export async function analyticsState(db: PoolClient, member?: string) {
  const state = emptyState();
  const profiles = await db.query(`SELECT id,p.* FROM klan_users,jsonb_to_record(data) p("publicId" float8,name text,username text,
    initials text,color text,role text,"joinedAt" text,location jsonb,bio text,tags jsonb,facts jsonb,interests jsonb,achievements jsonb)
    ${member ? "WHERE id=$1 OR data->>'publicId'=$1" : ''} ORDER BY id`, member ? [member] : []);
  state.users = profiles.rows as User[];
  if (member && !state.users.length) throw notFound();
  const args = member ? [state.users[0]!.id] : [];
  state.activities = (await db.query(`SELECT a.data, e.card->>'publicId' AS number, e.kind
    FROM klan_activities a LEFT JOIN klan_entities e ON e.id=split_part(a.data#>>'{target,path}','/',3) AND e.kind=split_part(a.data#>>'{target,path}','/',2)
    ${member ? "WHERE a.data#>>'{actor,id}'=$1" : ''} ORDER BY a.id`,args)).rows.map(row => {
    if (row.number && row.data.target) row.data.target.path = '/' + row.kind + '/' + row.number;
    return row.data;
  });
  state.entities = (await db.query(`SELECT id,kind AS type,p."publicId",p.title,p.status,p.schedule,p.goal,
    ARRAY(SELECT jsonb_build_object('user',r->'user') FROM jsonb_array_elements(p.participants) r) AS participants,
    coalesce(p.readers,'[]') AS readers,
    ARRAY(SELECT jsonb_build_object('user',r->'user','date',r->'date','value',r->'value') FROM jsonb_array_elements(p.results) r
      ${member ? "WHERE r#>>'{user,id}'=$1" : ''}) AS results
    FROM klan_entities,jsonb_to_record(detail) p("publicId" float8,title text,status text,schedule jsonb,goal jsonb,participants jsonb,readers jsonb,results jsonb)
    ${member ? `WHERE detail @> jsonb_build_object('participants',jsonb_build_array(jsonb_build_object('user',jsonb_build_object('id',$1::text))))
      OR detail @> jsonb_build_object('readers',jsonb_build_array(jsonb_build_object('id',$1::text)))
      OR detail @> jsonb_build_object('results',jsonb_build_array(jsonb_build_object('user',jsonb_build_object('id',$1::text))))` : ''} ORDER BY id`,args)).rows as Entity[];
  return state;
}
