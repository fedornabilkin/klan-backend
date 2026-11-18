import test from 'node:test';
import assert from 'node:assert/strict';
import type { Entity, User } from '../../src/shared/contracts.js';
import { profileEntryText } from '../../src/shared/profile-entries.js';
import { emptyState, MemoryRepository } from '../../src/repository.js';
import { applyTelegramImport, fullNameKey, planTelegramImport, TelegramImportError } from './telegram-import.js';
import { hydrateUser } from '../../src/domain.js';

const info={sourceHash:'a'.repeat(64),importedAt:'2026-11-13T10:00:00.000Z'};
const mapping={'3D-печать':'3D','3D-моделирование':'3D','Авиадвигатели':'Авиация','Авиация':'Авиация','Бег':'Спорт','Футбол':'Спорт'};
function user(id:string,name:string,extra:Partial<User>={}):User{
  return {id,name,username:`manual_${id}`,role:'member',publicId:1,bio:'Ручное описание',
    location:{city:'Москва',country:'Россия',lat:55.75,lng:37.61},tags:[],initials:'ИИ',color:'#123456',
    facts:[{id:`manual-${id}`,text:'Сохранённый вручную факт',date:null}],interests:['Музыка'],achievements:[],
    stats:{events:2,challenges:3,books:4},joinedAt:'2025-01-01T00:00:00.000Z',...extra};
}
function person(id:string,name:string,extra:Record<string,unknown>={}){
  return {id:`telegram:${id}`,name,callsign:'',telegram:{id,username:null},bio:'Новые сведения из знакомства',
    location:{city:'Казань',country:'Россия',lat:null,lng:null},facts:[{id:`fact-${id}`,text:'Новый факт',date:null,dateText:''}],
    achievements:[],tagNames:['3D-печать'],sourceMessageIds:[Number(id)],latestIntroductionPublishedAt:'2026-10-01T10:00:00.000Z',...extra};
}
const source=(people:ReturnType<typeof person>[])=>({schemaVersion:'1.0',people,tagCatalog:[]});
const verified=(id:string,username:string)=>({id,username,profileVerification:'verified_in_Telegram_Desktop'});

test('deferred identity is rejected before matching; skip-conflicts imports only the remaining people',()=>{
  const state=emptyState();
  state.users=[user('owner','Тестовый Владелец',{role:'admin',username:'owner_account'})];
  const ownerBefore=structuredClone(state.users[0]);
  const input=source([person('9301','Тестовый Владелец',{telegram:verified('9301','owner_account')}),person('9302','Новый Участник')]);
  const options={...info,deferredTelegramIds:['9301'],reviewedMatches:{'9301':'owner'}};
  assert.throws(()=>applyTelegramImport(state,input,mapping,options),(error:unknown)=>error instanceof TelegramImportError&&error.code==='IMPORT_CONFLICTS');
  assert.deepEqual(state.users,[ownerBefore]);assert.deepEqual(state.telegramUsers,{});
  const report=applyTelegramImport(state,input,mapping,{...options,skipConflicts:true});
  assert.equal(report.created,1);assert.deepEqual(report.conflicts.map(c=>({id:c.telegramId,code:c.code})),[{id:'9301',code:'IDENTITY_REVIEW_REQUIRED'}]);
  assert.deepEqual(state.users.find(u=>u.id==='owner'),ownerBefore);
  assert.equal(state.telegramUsers['9301'],undefined);assert.equal(state.telegramUsers['9302'],'telegram-9302');
  assert.equal(report.decisions.some(d=>d.telegramId==='9301'),false);
});

test('full names normalize case, ё, spacing and order but never match a first name or initials',()=>{
  assert.equal(fullNameKey('  ПЁТР   СЕМЁНОВ '),fullNameKey('Семенов Петр'));
  assert.equal(fullNameKey('Иван Сергеевич Петров'),fullNameKey('Петров Иван Сергеевич'));
  assert.equal(fullNameKey('Иван Петров [Сокол]'),fullNameKey('Петров Иван'));
  for(const name of ['Иван','@ivan_petrov','И. Петров','Иван 123','Иван Петров | Бизнес'])assert.equal(fullNameKey(name),undefined);
});

test('matches 144 manual profiles by Telegram ID, username and full name without duplicating or replacing identity',()=>{
  const state=emptyState();
  state.users=Array.from({length:144},(_,i)=>user(`manual${i}`,`Участник-${i} Архивный`,{publicId:i+1}));
  state.users[0]=user('manual0','Иван Петров',{publicId:1,username:'Existing_One',role:'admin'});
  state.users[1]=user('manual1','Алексей Кузнецов',{publicId:2,username:'Verified_Two'});
  state.users[2]=user('manual2','Пётр Семёнов',{publicId:3,username:'kept_username'});
  state.telegramUsers['1001']='manual0';
  const before=structuredClone(state);
  const input=source([
    person('1001','Иван Петров'),
    person('1002','Алексей Кузнецов',{telegram:verified('1002','verified_two')}),
    person('1003','  СЕМЕНОВ  ПЕТР '),
  ]);
  const plan=planTelegramImport(state,input,mapping,info);
  assert.deepEqual(state,before,'preview must be pure');
  assert.equal(plan.state.users.length,144);
  assert.equal(plan.report.created,0);
  assert.equal(plan.report.updated,3);
  assert.equal(plan.report.matchedByTelegramId,1);
  assert.equal(plan.report.matchedByUsername,1);
  assert.equal(plan.report.matchedByFullName,1);
  assert.deepEqual(plan.report.conflicts,[]);
  for(let i=0;i<144;i++){
    const old=before.users[i]!,next=plan.state.users[i]!;
    for(const field of ['id','publicId','username','role','joinedAt'] as const)assert.equal(next[field],old[field]);
    if(i<3){
      assert.equal(next.location.city,'Казань');
      assert.deepEqual((next as User & {communityImport:{previousLocation:User['location']}}).communityImport.previousLocation,old.location);
    }else assert.deepEqual(next.location,old.location);
    assert.ok(next.facts.some(f=>profileEntryText(f)==='Сохранённый вручную факт'));
  }
  assert.equal(plan.state.telegramUsers['1002'],'manual1');
  assert.equal(plan.state.telegramUsers['1003'],'manual2');
});

test('verified current city receives local coordinates while unchanged cities retain manual coordinates',()=>{
  const state=emptyState();state.users=[user('one','Иван Петров'),user('two','Олег Сидоров')];
  const input=source([person('9101','Иван Петров'),person('9102','Олег Сидоров',{location:{city:'Москва',country:'Россия',lat:null,lng:null}})]);
  const plan=planTelegramImport(state,input,mapping,{...info,resolvedLocations:{'9101':{city:'Казань',country:'Россия',lat:55.79,lng:49.12},'9102':{city:'Москва',country:'Россия',lat:55.7,lng:37.6}}});
  assert.deepEqual(plan.state.users[0]!.location,{city:'Казань',country:'Россия',lat:55.79,lng:49.12});
  assert.deepEqual(plan.state.users[1]!.location,state.users[1]!.location);
  assert.equal('communityImport' in hydrateUser(plan.state,plan.state.users[0]!),false);
});

test('two source names matching one manual profile remain unresolved until an explicit reviewed new ID separates them',()=>{
  const state=emptyState();state.users=[user('one','Алексей Дорохин [Большой]')];
  const input=source([person('9201','Алексей Дорохин'),person('9202','Алексей Дорохин')]);
  const ambiguous=planTelegramImport(state,input,mapping,info);
  assert.equal(ambiguous.report.conflicts.length,2);assert.equal(ambiguous.report.created,0);assert.equal(ambiguous.report.authBindingsAdded,0);
  const reviewed=planTelegramImport(state,input,mapping,{...info,reviewedMatches:{'9202':'one'},reviewedNewIds:['9201']});
  assert.equal(reviewed.report.conflicts.length,0);assert.equal(reviewed.state.users.length,2);
  assert.equal(reviewed.state.telegramUsers['9202'],'one');assert.equal(reviewed.state.telegramUsers['9201'],'telegram-9201');
});

test('ambiguous full names are reported and an apply transaction rolls back even unrelated safe rows',async()=>{
  const state=emptyState();
  state.users=[user('one','Иван Петров'),user('two','Петров Иван')];
  const input=source([person('2001','Иван Петров'),person('2002','Новый Участник')]);
  const plan=planTelegramImport(state,input,mapping,info);
  assert.equal(plan.report.conflicts[0]?.code,'AMBIGUOUS_FULL_NAME');
  assert.equal(plan.report.created,1);
  const repo=new MemoryRepository(state);
  await assert.rejects(repo.write(s=>applyTelegramImport(s,input,mapping,info)),(error:unknown)=>error instanceof TelegramImportError&&error.code==='IMPORT_CONFLICTS');
  assert.deepEqual(await repo.read(s=>s),state);
  const result=await repo.write(s=>applyTelegramImport(s,input,mapping,{...info,skipConflicts:true}));
  assert.equal(result.created,1);
  assert.equal((await repo.read(s=>s.users)).length,3);
  assert.equal(await repo.read(s=>s.telegramUsers['2001']),undefined);
});

test('a profile already bound to a different Telegram ID is not reassigned by matching name',()=>{
  const state=emptyState();state.users=[user('kept','Алексей Иванов')];state.telegramUsers['3000']='kept';
  const plan=planTelegramImport(state,source([person('3001','Алексей Иванов')]),mapping,info);
  assert.equal(plan.report.conflicts[0]?.code,'EXISTING_TELEGRAM_BINDING');
  assert.equal(plan.report.created,0);
  assert.equal(plan.state.telegramUsers['3001'],undefined);
  assert.deepEqual(plan.state.telegramUsers,{'3000':'kept'});
});

test('a new account receives a deterministic internal ID, new public ID and member role; reruns are idempotent',()=>{
  const state=emptyState();state.userPublicIds.highWater=400;
  const input=source([person('4001','Сергей Соколов',{
    callsign:'Сокол',telegram:verified('4001','sergey_demo'),role:'admin',access:{level:'admin'},
    facts:[{id:'dated-fact',text:'Прошёл обучение.',date:null,dateText:'2024 год'}],tagNames:['3D-печать','3D-моделирование'],
  })]);
  const first=applyTelegramImport(state,input,mapping,info);
  assert.equal(first.created,1);
  const added=state.users[0]!;
  assert.equal(added.id,'telegram-4001');assert.equal(added.publicId,401);assert.equal(added.role,'member');assert.equal(added.access,undefined);
  assert.equal(added.callsign,'Сокол');assert.equal(added.username,'sergey_demo');assert.equal(state.telegramUsers['4001'],added.id);
  assert.deepEqual(added.tags.map(t=>t.name),['3D']);
  assert.equal(profileEntryText(added.facts[0]!), 'Прошёл обучение. (2024 год)');
  const afterFirst=structuredClone(state);
  const second=applyTelegramImport(state,input,mapping,{...info,importedAt:'2026-11-14T10:00:00.000Z'});
  assert.equal(second.created,0);assert.equal(second.updated,0);assert.equal(second.unchanged,1);assert.equal(second.authBindingsAdded,0);
  assert.deepEqual(state,afterFirst);
});

test('conflicting username and Telegram ID cannot merge two existing people',()=>{
  const state=emptyState();state.users=[user('id-owner','Иван Петров',{username:'id_owner'}),user('name-owner','Павел Сидоров',{username:'other_owner'})];
  state.telegramUsers['5001']='id-owner';
  const plan=planTelegramImport(state,source([person('5001','Иван Петров',{telegram:verified('5001','other_owner')})]),mapping,info);
  assert.equal(plan.report.conflicts[0]?.code,'USERNAME_ID_CONFLICT');
  assert.equal(plan.report.created,0);assert.equal(plan.report.updated,0);
});

test('a patronymic difference is a review candidate, not a duplicate or guessed merge',()=>{
  const state=emptyState();state.users=[user('manual','Иван Сергеевич Петров')];
  const plan=planTelegramImport(state,source([person('6001','Иван Петров')]),mapping,info);
  assert.equal(plan.report.conflicts[0]?.code,'POSSIBLE_NAME_MATCH');assert.equal(plan.report.created,0);
});

test('merge limits report a conflict without truncating existing or source information',()=>{
  const state=emptyState();state.users=[user('full','Павел Орлов',{bio:'A'.repeat(3000)})];
  const plan=planTelegramImport(state,source([person('7001','Павел Орлов',{bio:'B'.repeat(3000)})]),mapping,info);
  assert.equal(plan.report.conflicts[0]?.code,'PROFILE_LIMIT_OR_VALIDATION');
  assert.equal(plan.state.users[0]!.bio,'A'.repeat(3000));assert.equal(plan.state.telegramUsers['7001'],undefined);
  state.users[0]!.bio='';state.users[0]!.facts=Array.from({length:100},(_,i)=>({id:`old-${i}`,text:`Ручной факт номер ${i}`,date:null}));
  const factsPlan=planTelegramImport(state,source([person('7001','Павел Орлов')]),mapping,info);
  assert.equal(factsPlan.report.conflicts[0]?.code,'PROFILE_LIMIT_OR_VALIDATION');assert.equal(factsPlan.state.users[0]!.facts.length,100);
});

test('tag grouping covers existing users, event tags and embedded user snapshots',()=>{
  const state=emptyState();
  const tag3d={id:'old-3d',name:'3D-печать'},tagAir={id:'old-air',name:'Авиадвигатели'},tagRun={id:'old-run',name:'Бег'};
  const current=user('current','Текущий Участник',{tags:[tag3d]});
  const snapshot=user('historic','Исторический Участник',{tags:[tagRun]});
  state.users=[current];state.tags=[tag3d,tagAir,tagRun];
  state.entities=[{id:'event',type:'events',title:'Событие',description:'',status:'active',category:'',createdAt:'2026-01-01T00:00:00.000Z',tags:[tagAir],participants:[{user:snapshot}],author:snapshot,readers:[snapshot],results:[{user:snapshot,date:'2026-01-01',value:1}]} as Entity];
  const plan=planTelegramImport(state,source([]),mapping,info);
  assert.deepEqual(plan.state.users[0]!.tags.map(t=>t.name),['3D']);
  const entity=plan.state.entities[0]!;
  assert.deepEqual(entity.tags.map(t=>t.name),['Авиация']);
  assert.deepEqual(entity.participants[0]!.user.tags.map(t=>t.name),['Спорт']);
  assert.deepEqual(entity.author!.tags.map(t=>t.name),['Спорт']);
  assert.deepEqual(entity.readers![0]!.tags.map(t=>t.name),['Спорт']);
  assert.deepEqual(entity.results![0]!.user.tags.map(t=>t.name),['Спорт']);
  assert.equal(new Set(plan.state.tags.map(t=>t.name)).size,plan.state.tags.length);
});

test('two incoming accounts claiming the same existing username are both excluded',()=>{
  const state=emptyState();state.users=[user('claimed','Антон Смирнов',{username:'same_handle'})];
  const input=source([person('8001','Первый Автор',{telegram:verified('8001','same_handle')}),person('8002','Второй Автор',{telegram:verified('8002','same_handle')})]);
  const before=structuredClone(state);
  assert.throws(()=>planTelegramImport(state,input,mapping,info),(error:unknown)=>error instanceof TelegramImportError&&error.code==='DUPLICATE_SOURCE_USERNAME');
  assert.deepEqual(state,before);
});

test('two new incoming accounts cannot create duplicate verified usernames',()=>{
  const state=emptyState();
  const input=source([person('9001','Первый Автор',{telegram:verified('9001','shared_handle')}),person('9002','Второй Автор',{telegram:verified('9002','shared_handle')})]);
  let rejected=false;
  try{
    const plan=planTelegramImport(state,input,mapping,info);
    rejected=plan.report.conflicts.length===2&&plan.report.created===0;
  }catch(error){rejected=error instanceof TelegramImportError;}
  assert.ok(rejected,'Duplicate verified username must fail validation or exclude both candidates');
});

test('grouping handles historical snapshot-only tags and retains their catalog references',()=>{
  const state=emptyState();
  const snapshot=user('historic','Исторический Участник',{tags:[{id:'old-run',name:'Бег'}]});
  state.entities=[{id:'event',type:'events',title:'Событие',description:'',status:'active',category:'',createdAt:'2026-01-01T00:00:00.000Z',tags:[],participants:[{user:snapshot}]} as Entity];
  const plan=planTelegramImport(state,source([]),mapping,info);
  const tag=plan.state.entities[0]!.participants[0]!.user.tags[0]!;
  assert.equal(tag.name,'Спорт');
  assert.ok(plan.state.tags.some(t=>t.id===tag.id),'Historical tags must not become dangling references');
});

test('reviewed matches can disambiguate identical names while preserving the selected manual account',()=>{
  const state=emptyState();state.users=[user('first','Иван Петров'),user('second','Иван Петров')];
  const input=source([person('9101','Иван Петров')]);
  const plan=planTelegramImport(state,input,mapping,{...info,reviewedMatches:{'9101':'second'}});
  assert.deepEqual(plan.report.conflicts,[]);
  assert.equal(plan.report.created,0);
  assert.equal(plan.state.telegramUsers['9101'],'second');
  assert.equal(plan.report.decisions[0]?.method,'reviewed');
});

test('reviewed matches cannot override a pre-existing different Telegram identity',()=>{
  const state=emptyState();state.users=[user('target','Иван Сергеевич Петров')];state.telegramUsers['9200']='target';
  const plan=planTelegramImport(state,source([person('9201','Иван Петров')]),mapping,{...info,reviewedMatches:{'9201':'target'}});
  assert.equal(plan.report.conflicts[0]?.code,'EXISTING_TELEGRAM_BINDING');
  assert.equal(plan.state.telegramUsers['9201'],undefined);
});
