import { entityCard } from './resource-reads.js';
import { createSeed } from './seed.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { migratedGoal } from './challenge-goals.js';

test('legacy goals are converted once and the verified October target is 1000 per member', () => {
  const old = {target:421841,unit:'упражнений'};
  const october = migratedGoal('history-challenge-f24c7cb336799a547084efb9','count',old,433);
  assert.equal(october.target,1000);
  assert.equal(october.target*433,433000);
  assert.equal(migratedGoal('history-challenge-f24c7cb336799a547084efb9','count',{...october,target:1200},433).target,1200);
  assert.equal(migratedGoal('other','count',{target:100,unit:'раз'},10).target,10);
  assert.equal(migratedGoal('empty','count',old,0).target,421841);
  assert.equal(migratedGoal('visits','attendance',{target:23,unit:'дней'},6).target,4);
});

test('challenge cards count distinct enrolled teams and exclude solo and historical results', () => {
  const state = createSeed();
  const challenge = state.entities.find(entity => entity.type === 'challenges')!;
  const [a,b,c] = state.users;
  const team = {id:'team-a',title:'А'};
  challenge.participants = [{user:a!,team},{user:b!,team},{user:c!}];
  challenge.results = [{user:c!,date:'2026-10-01',value:10,team:{id:'old-team',title:'Б'}}];
  assert.equal(entityCard(challenge).teamCount, 1);
  challenge.participants = [];
  assert.equal(entityCard(challenge).teamCount, 0);
});
