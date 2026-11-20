import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSeed } from './seed.js';
import { dashboardTeamRanking, rankingCandidates } from './community-reads.js';

test('главная предпочитает текущий челлендж, затем завершённый; будущие и черновики скрыты', () => {
  const now = new Date('2026-11-20');
  const base = createSeed(now).entities.find(e => e.type === 'challenges')!;
  const challenge = (id: string, status: string, start: string, end: string) =>
    ({...base, id, status, schedule:{start, end}});
  const entities = [
    challenge('previous','completed','2026-10-01','2026-10-31'),
    challenge('next','active','2026-11-21','2026-11-30'),
    challenge('current','active','2026-11-01','2026-11-30'),
    challenge('draft','draft','2026-11-17','2026-11-30'),
    challenge('latest','active','2026-11-15','2026-11-25'),
  ];
  assert.deepEqual(rankingCandidates(entities, now).map(e => e.id), ['latest','current','previous']);
});

test('четыре места совпадают с командным зачётом, при равенстве учитывается название', () => {
  const seed = createSeed();
  const challenge = seed.entities.find(e => e.type === 'challenges')!;
  const base = seed.entities.find(e => e.type === 'teams')!;
  const teams = ['10','3','2','1','4','5'].map(id => ({...base,id,title:'Команда '+id}));
  teams[4]!.status = 'draft';
  const ranking = dashboardTeamRanking(challenge, teams, new Map([['2',10],['3',20],['10',10],['4',1000]]));
  assert.deepEqual(ranking.leaders.map(t => [t.id,t.score]), [['3',20],['2',10],['10',10],['1',0]]);
});
