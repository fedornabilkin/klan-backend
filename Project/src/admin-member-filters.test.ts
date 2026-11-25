import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';
import { membersMissing, missingMemberFields, type MissingMemberField } from './admin-member-filters.js';
import { querySchema } from './domain.js';
import { readList } from './resource-reads.js';
import { emptyState } from './repository.js';
import { createSeed } from './seed.js';
import type { User } from './shared/contracts.js';

function fixture() {
  const state = emptyState(), seed = createSeed();
  const member = (id: string): User => ({
    ...seed.users[0]!, id, name: 'Участник ' + id, bio: '', location: {city: '', country: '', lat: null, lng: null},
    tags: [], facts: [], achievements: [],
  });
  const empty = member('empty'), filled = member('filled'), former = member('former'), excluded = member('excluded');
  const past = member('past'), pending = member('pending'), zero = member('zero');
  state.users = [empty, filled, former, excluded, past, pending, zero];
  Object.assign(empty, {username: 'only_handle', bio: ' \n', facts: [' ', 'PCM (из исходного файла): старое поле'], achievements: [{id:'a',text:'\t', date:null}]});
  Object.assign(filled, {bio: 'Описание', tags: [{id:'t',name:'Тег'}], facts: ['Факт'], achievements: [{id:'a',text:'Достижение',date:null}]});
  filled.location.city = 'Тула';
  former.tags = filled.tags;
  excluded.location.city = 'Омск';
  past.bio = 'Рассказ о себе';
  pending.facts = [{id:'f',text:'Факт о себе',date:null}];
  former.achievements = ['Достижение из архива'];
  state.telegramUsers['123456'] = filled.id;
  state.sessions.old = {userId: past.id, expiresAt:'2020-01-01T00:00:00Z'};
  state.activities = [
    { ...seed.activities[0]!, actor: filled, action: 'вошёл в сообщество' },
    { ...seed.activities[0]!, actor: former, action: 'отменил участие', target: {title:'Архив', path:'/teams/42'} },
  ];
  state.teamExclusions = [{id:'x', teamId:'team', userId:excluded.id, adminId:filled.id, comment:'Исключение',createdAt:'2020-01-01'}];
  const team = {id: 'team', title: 'Архив'};
  const entity = seed.entities[0]!;
  state.entities = [
    {...entity, ...team, type:'teams', status:'archived', participants:[{user:filled}]},
    {...entity, id:'challenge', type:'challenges', status:'archived', participants:[{user:empty},{user:past,team}],
      results:[{user:filled,value:2,date:'2020-01-01',team},{user:zero,value:0,date:'2020-01-01'}],
      pendingResults:[{user:pending,value:5,team,sourceCell:'A1',reason:'нет даты'}]},
  ];
  return state;
}

const fields: MissingMemberField[] = ['telegram','login','city','tags','bio','facts','achievements','teams','results'];
test('missing member filters distinguish bindings, login, roster history and confirmed exercise results', () => {
  const state = fixture();
  const ids = (...missing: MissingMemberField[]) => membersMissing(state, missing).map(user => user.id);
  assert.deepEqual(ids('telegram'), ['empty','former','excluded','past','pending','zero']);
  assert.deepEqual(ids('city'), ['empty','former','past','pending','zero']);
  assert.deepEqual(ids('tags'), ['empty','excluded','past','pending','zero']);
  assert.deepEqual(ids('bio'), ['empty','former','excluded','pending','zero']);
  assert.deepEqual(ids('facts'), ['empty','former','excluded','past','zero']);
  assert.deepEqual(ids('achievements'), ['empty','excluded','past','pending','zero']);
  assert.deepEqual(ids('results'), ['empty','former','excluded','past','pending','zero']);
  assert.deepEqual(ids('login'), ['empty','former','excluded','pending','zero']);
  assert.deepEqual(ids('teams'), ['empty','zero']);
  assert.deepEqual(ids(...fields), ['empty','zero']);
  assert.deepEqual(missingMemberFields.parse('city,tags,city'), ['city','tags']);
  assert.throws(() => missingMemberFields.parse('city,other'));
});

test('PostgreSQL returns the same filtered pages, even for empty pages and compound searches',
  { skip: !process.env.TEST_DATABASE_URL }, async () => {
    const pool = new pg.Pool({connectionString:process.env.TEST_DATABASE_URL});
    const db = await pool.connect();
    try {
      await db.query('BEGIN');
      await db.query(`CREATE TEMP TABLE klan_users(id text, data jsonb);
        CREATE TEMP TABLE klan_entities(id text, kind text, data jsonb, card jsonb, detail jsonb);
        CREATE TEMP TABLE klan_activities(data jsonb);
        CREATE TEMP TABLE klan_team_exclusions(data jsonb);
        CREATE TEMP TABLE klan_auth(kind text, data jsonb)`);
      const state = fixture();
      for (const user of state.users) await db.query('INSERT INTO pg_temp.klan_users VALUES($1,$2)', [user.id,user]);
      for (const entity of state.entities) await db.query('INSERT INTO pg_temp.klan_entities VALUES($1,$2,$3,$3,$3)', [entity.id,entity.type,entity]);
      for (const row of state.activities) await db.query('INSERT INTO pg_temp.klan_activities VALUES($1)', [row]);
      for (const row of state.teamExclusions) await db.query('INSERT INTO pg_temp.klan_team_exclusions VALUES($1)', [row]);
      for (const kind of ['telegramUsers','sessions'] as const) for (const value of Object.values(state[kind]))
        await db.query('INSERT INTO pg_temp.klan_auth VALUES($1,$2)', [kind,JSON.stringify(value)]);
      for (const missing of [...fields.map(field => [field]), fields]) {
        const page = await readList(db,'users',querySchema.parse({limit:2,page:2}),true,true,missing);
        const ids = membersMissing(state,missing).map(user => user.id).sort();
        assert.equal(page.meta.total,ids.length);
        assert.deepEqual(page.data.map(u => u.id),ids.slice(2,4));
      }
      const searched = await readList(db,'users',querySchema.parse({q:'участник ZERO',sort:'name'}),true,true,fields);
      assert.deepEqual(searched.data.map(u => u.id),['zero']);
    } finally {
      try { await db.query('ROLLBACK'); } finally { db.release(); await pool.end(); }
    }
  });
