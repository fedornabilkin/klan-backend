import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Location, ProfileEntry, Tag, User } from '../../src/shared/contracts.js';
import { isCalendarDate, normalizeProfileEntries } from '../../src/shared/profile-entries.js';
import { profileSchema } from '../../src/domain.js';
import { allocateUserPublicId } from '../../src/user-ids.js';
import type { DatabaseState } from '../../src/repository.js';

const idSchema = z.string().regex(/^[1-9]\d{0,19}$/);
const entrySchema = z.object({ id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/), text: z.string().trim().min(1).max(1000), date: z.string().refine(isCalendarDate).nullable(), dateText: z.string().max(250).optional() });
const personSchema = z.object({
  id: z.string().min(1), name: z.string().trim().min(1).max(120), callsign: z.string().max(120).default(''),
  telegram: z.object({ id: idSchema, username: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{4,31}$/).nullable(), profileVerification: z.string().optional() }),
  bio: z.string().max(5000), location: z.object({ city: z.string().max(100), country: z.string().max(100), lat: z.number().min(-90).max(90).nullable(), lng: z.number().min(-180).max(180).nullable() }),
  facts: z.array(entrySchema).max(100), achievements: z.array(entrySchema).max(100), tagNames: z.array(z.string().trim().min(1).max(120)), sourceMessageIds: z.array(z.number().int().positive()),
  latestIntroductionPublishedAt: z.string(),
});
const sourceSchema = z.object({ schemaVersion: z.literal('1.0'), people: z.array(personSchema), tagCatalog: z.array(z.object({id:z.string(),name:z.string()})) });
export type TelegramImportPerson = z.infer<typeof personSchema>;
export type TagGrouping = Record<string, string>;
export interface TelegramImportProvenance { importer: 'telegram-introductions'; version: 1; sourceHash: string; sourcePersonId: string; telegramId: string; sourceMessageIds: number[]; importedAt: string; previousLocation?:Location; }
type ImportedUser = User & { communityImport?: TelegramImportProvenance };
export interface ImportConflict { telegramId: string; sourceName: string; code: string; candidates: {id:string;name:string;username?:string}[]; detail?:string; }
export interface ImportDecision { telegramId: string; sourceName: string; userId: string; existingName?:string; method: 'telegram_id'|'username'|'full_name'|'reviewed'|'new'; status:'created'|'updated'|'unchanged'; }
export interface TelegramImportReport {
  sourcePeople:number; usersBefore:number; usersAfter:number; created:number; updated:number; unchanged:number; matchedByTelegramId:number; matchedByUsername:number; matchedByFullName:number;
  authBindingsAdded:number; tagsBefore:number; tagsAfter:number; profilesRetagged:number; conflicts:ImportConflict[]; decisions:ImportDecision[]; unmappedTags:string[];
}
export interface TelegramImportPlan { state: DatabaseState; report: TelegramImportReport; }
export class TelegramImportError extends Error { constructor(public code:string,message:string){super(message);this.name='TelegramImportError';} }
const key=(value:string)=>value.normalize('NFKC').toLocaleLowerCase('ru').replaceAll('ё','е').replace(/\s+/gu,' ').trim();
const usernameKey=(value:string|undefined|null)=>key(value??'').replace(/^@/,'');
const textKey=(value:string)=>key(value).replace(/[\p{P}\p{S}]+/gu,' ').replace(/\s+/g,' ').trim();
const hash=(value:string)=>createHash('sha256').update(value).digest('hex').slice(0,24);
/** A lone first name or handle never forms an identity key. Order may differ in manual lists. */
export function fullNameKey(name:string): string | undefined {
  const parts=key(name.replace(/\[[^\]]*\]/gu,' ').replace(/\s+/gu,' ')).split(/\s+/u);
  if(parts.length<2||parts.length>3||parts.some(part=>!/^\p{L}{2,}(?:[-’']\p{L}{2,})?$/u.test(part)))return undefined;
  return parts.sort((a,b)=>a.localeCompare(b,'ru')).join(' ');
}
function editDistance(a:string,b:string):number{
  let row=Array.from({length:b.length+1},(_,i)=>i);
  for(let i=1;i<=a.length;i++){const next=[i];for(let j=1;j<=b.length;j++)next[j]=Math.min(next[j-1]!+1,row[j]!+1,row[j-1]!+(a[i-1]===b[j-1]?0:1));row=next;}
  return row[b.length]!;
}
function possibleNameMatch(a:string,b:string):boolean{
  const aa=fullNameKey(a)?.split(' '),bb=fullNameKey(b)?.split(' ');
  if(!aa||!bb)return false;
  const shared=aa.filter(t=>bb.includes(t));
  if(shared.length>=2)return true;
  if(shared.length!==1)return false;
  const left=aa.filter(t=>!shared.includes(t)),right=bb.filter(t=>!shared.includes(t));
  return left.length===1&&right.length===1&&Math.min(left[0]!.length,right[0]!.length)>=3&&(editDistance(left[0]!,right[0]!)<=2||left[0]!.startsWith(right[0]!)||right[0]!.startsWith(left[0]!));
}
const candidate=(u:User)=>({id:u.id,name:u.name,...(u.username?{username:u.username}:{})});
function addIndex<K>(index:Map<K,User[]>,k:K|undefined,u:User){if(k!==undefined)index.set(k,[...(index.get(k)??[]),u]);}
function mergeEntries(oldEntries:User['facts'], incoming:TelegramImportPerson['facts'],scope:string):ProfileEntry[]{
  const output=normalizeProfileEntries(oldEntries,scope);
  for(const raw of incoming){
    const dateText=raw.dateText?.trim();
    const text=dateText&&!textKey(raw.text).includes(textKey(dateText))?`${raw.text} (${dateText})`:raw.text;
    const sameId=output.find(e=>e.id===raw.id);
    if(sameId){
      if(textKey(sameId.text)!==textKey(text)||sameId.date!==raw.date)throw new TelegramImportError('ENTRY_ID_CONFLICT',`Entry ${raw.id} was changed; preserve and review it`);
      continue;
    }
    const sameText=output.find(e=>textKey(e.text)===textKey(text));
    if(sameText){if(sameText.date===null&&raw.date!==null)sameText.date=raw.date;continue;}
    output.push({id:raw.id,text,date:raw.date});
  }
  return output;
}
function mergeBio(old:string,incoming:string):string{
  if(!old.trim())return incoming;
  if(!incoming.trim()||key(old).includes(key(incoming)))return old;
  if(key(incoming).includes(key(old)))return incoming;
  return `${old}\n\n${incoming}`;
}
const embeddedUsers=(state:DatabaseState)=>state.entities.flatMap(e=>[...e.participants.map(p=>p.user),...(e.author?[e.author]:[]),...(e.readers??[]),...(e.results??[]).map(r=>r.user)]);
function groupedTags(state:DatabaseState,mapping:TagGrouping,sourceTags:string[]){
  const aliases=new Map(Object.entries(mapping).map(([name,canonical])=>[key(name),canonical]));
  const known=new Map(Object.values(mapping).map(name=>[key(name),name]));
  const unmapped=new Set<string>();
  const canonicalName=(name:string)=>aliases.get(key(name))||known.get(key(name))||(unmapped.add(name),name.trim());
  const all=[...state.tags,...state.users.flatMap(u=>u.tags),...embeddedUsers(state).flatMap(u=>u.tags),...state.entities.flatMap(e=>e.tags),...sourceTags.map(name=>({id:'',name}))];
  const catalog=new Map<string,Tag>();
  const reservedIds=new Map<string,string>();
  // Prefer an existing ID only if the existing name is already canonical.
  for(const tag of all){const name=canonicalName(tag.name),k=key(name);if(!catalog.has(k)&&key(tag.name)===k&&tag.id&&(!reservedIds.has(tag.id)||reservedIds.get(tag.id)===k)){catalog.set(k,{id:tag.id,name});reservedIds.set(tag.id,k);}}
  for(const tag of all){const name=canonicalName(tag.name),k=key(name);if(!catalog.has(k)){const id=`topic-${hash(k)}`;if(reservedIds.has(id)&&reservedIds.get(id)!==k)throw new TelegramImportError('TAG_ID_CONFLICT','A grouped tag ID is already used for another name');catalog.set(k,{id,name});reservedIds.set(id,k);}}
  const canonical=(tags:Tag[])=>[...new Map(tags.map(tag=>{const v=catalog.get(key(canonicalName(tag.name)))!;return [v.id,{...v}] as const;})).values()];
  return {catalog,canonical,unmapped};
}
/** Pure preview. The original state is never modified, even on validation failures. */
export interface TelegramImportOptions { sourceHash:string;importedAt:string;reviewedMatches?:Record<string,string>;reviewedNewIds?:string[];deferredTelegramIds?:string[];resolvedLocations?:Record<string,Location>; }
export function planTelegramImport(initial:DatabaseState,input:unknown,mapping:TagGrouping,options:TelegramImportOptions):TelegramImportPlan{
  if(!/^[a-f0-9]{64}$/.test(options.sourceHash)||!Number.isFinite(Date.parse(options.importedAt)))throw new TelegramImportError('INVALID_SOURCE_INFO','Invalid import source metadata');
  const source=sourceSchema.parse(input);
  if(Object.values(mapping).some(name=>!name.trim()||name.length>80))throw new TelegramImportError('INVALID_TAG_MAPPING','Invalid grouped tag name');
  const seen=new Set<string>(),seenUsernames=new Set<string>();
  for(const p of source.people){
    if(seen.has(p.telegram.id))throw new TelegramImportError('DUPLICATE_TELEGRAM_ID',`Repeated Telegram ID ${p.telegram.id}`);
    seen.add(p.telegram.id);
    if(p.telegram.username){
      if(p.telegram.profileVerification!=='verified_in_Telegram_Desktop')throw new TelegramImportError('UNVERIFIED_USERNAME',`Profile username is not verified: ${p.telegram.id}`);
      const username=usernameKey(p.telegram.username);
      if(seenUsernames.has(username))throw new TelegramImportError('DUPLICATE_SOURCE_USERNAME',`Repeated verified Telegram username at ${p.telegram.id}`);
      seenUsernames.add(username);
    }
  }
  const state=structuredClone(initial);
  const report:TelegramImportReport={sourcePeople:source.people.length,usersBefore:state.users.length,usersAfter:state.users.length,created:0,updated:0,unchanged:0,matchedByTelegramId:0,matchedByUsername:0,matchedByFullName:0,authBindingsAdded:0,tagsBefore:state.tags.length,tagsAfter:0,profilesRetagged:0,conflicts:[],decisions:[],unmappedTags:[]};
  const usersById=new Map(initial.users.map(u=>[u.id,u]));
  const deferredIds=new Set(options.deferredTelegramIds??[]);
  for(const id of deferredIds)if(!seen.has(id))throw new TelegramImportError('INVALID_DEFERRED_ID','Deferred ID must reference an account in the source file');
  for(const [telegramId,userId] of Object.entries(options.reviewedMatches??{}))if(!seen.has(telegramId)||!usersById.has(userId))throw new TelegramImportError('INVALID_REVIEWED_MATCH','Reviewed mapping must reference source and existing IDs');
  const reviewedNew=new Set(options.reviewedNewIds??[]);
  for(const id of reviewedNew)if(!seen.has(id)||options.reviewedMatches?.[id])throw new TelegramImportError('INVALID_REVIEWED_MATCH','Reviewed new ID must reference a source account without a reviewed existing match');
  const names=new Map<string,User[]>(),usernames=new Map<string,User[]>();
  for(const user of initial.users){addIndex(names,fullNameKey(user.name),user);if(user.username)addIndex(usernames,usernameKey(user.username),user);}
  const sourceNames=new Map<string,number>();
  for(const p of source.people){const n=fullNameKey(p.name);if(n)sourceNames.set(n,(sourceNames.get(n)??0)+1);}
  const claimed=new Map<string,string>();
  const choices:{person:TelegramImportPerson;existing?:User;method:ImportDecision['method']}[]=[];
  const conflict=(p:TelegramImportPerson,code:string,candidates:User[]=[],detail?:string)=>report.conflicts.push({telegramId:p.telegram.id,sourceName:p.name,code,candidates:candidates.map(candidate),...(detail?{detail}:{})});
  for(const person of source.people){
    if(deferredIds.has(person.telegram.id)){conflict(person,'IDENTITY_REVIEW_REQUIRED');continue;}
    const name=fullNameKey(person.name),byName=name?names.get(name)??[]:[],byUsername=person.telegram.username?usernames.get(usernameKey(person.telegram.username))??[]:[];
    const boundId=initial.telegramUsers[person.telegram.id];
    const bound=boundId?usersById.get(boundId):undefined;
    if(boundId&&!bound){conflict(person,'DANGLING_TELEGRAM_BINDING',[],boundId);continue;}
    let existing:User|undefined,method:ImportDecision['method']='new';
    if(bound){existing=bound;method='telegram_id';}
    else if(reviewedNew.has(person.telegram.id)){method='new';}
    else if(options.reviewedMatches?.[person.telegram.id]){existing=usersById.get(options.reviewedMatches[person.telegram.id]);method='reviewed';if(!existing){conflict(person,'UNKNOWN_REVIEWED_TARGET');continue;}}
    else if(byUsername.length===1){existing=byUsername[0];method='username';}
    else if(byUsername.length>1){conflict(person,'AMBIGUOUS_USERNAME',byUsername);continue;}
    else if(byName.length===1&&sourceNames.get(name!)===1){existing=byName[0];method='full_name';}
    else if(byName.length){conflict(person,'AMBIGUOUS_FULL_NAME',byName);continue;}
    else if(name){
      // First name + surname may be a subset when only one side has a patronymic. Flag rather than guess.
      const near=initial.users.filter(u=>possibleNameMatch(person.name,u.name));
      if(near.length){conflict(person,'POSSIBLE_NAME_MATCH',near);continue;}
    }
    if(existing){
      if(byUsername.some(u=>u.id!==existing!.id)){conflict(person,'USERNAME_ID_CONFLICT',[existing,...byUsername]);continue;}
      if(method!=='telegram_id'&&method!=='reviewed'&&byName.some(u=>u.id!==existing!.id)){conflict(person,'NAME_USERNAME_CONFLICT',[existing,...byName]);continue;}
      if(existing.username&&person.telegram.username&&usernameKey(existing.username)!==usernameKey(person.telegram.username)){conflict(person,'USERNAME_CHANGED',[existing]);continue;}
      const otherBindings=Object.entries(initial.telegramUsers).filter(([id,userId])=>userId===existing!.id&&id!==person.telegram.id);
      if(otherBindings.length){conflict(person,'EXISTING_TELEGRAM_BINDING',[existing],otherBindings.map(([id])=>id).join(','));continue;}
      const previousImport=(existing as ImportedUser).communityImport;
      if(previousImport&&previousImport.telegramId!==person.telegram.id){conflict(person,'PREVIOUS_IMPORT_ID_CONFLICT',[existing]);continue;}
      const prior=claimed.get(existing.id);
      if(prior){
        const other=choices.find(c=>c.existing?.id===existing!.id);
        conflict(person,'MULTIPLE_SOURCE_ACCOUNTS',[existing]);
        if(other){conflict(other.person,'MULTIPLE_SOURCE_ACCOUNTS',[existing]);choices.splice(choices.indexOf(other),1);}continue;
      }
      claimed.set(existing.id,person.telegram.id);
    }else if(usersById.has(`telegram-${person.telegram.id}`)){conflict(person,'UNBOUND_INTERNAL_ID_COLLISION',[usersById.get(`telegram-${person.telegram.id}`)!]);continue;}
    choices.push({person,existing,method});
  }
  const grouped=groupedTags(state,mapping,source.people.flatMap(p=>p.tagNames));
  for(const {person,existing,method} of choices){
    const old=existing as ImportedUser|undefined;
    const id=old?.id??`telegram-${person.telegram.id}`;
    try{
      let user:ImportedUser;
      if(old?.communityImport?.sourceHash===options.sourceHash){user=structuredClone(old);}
      else{
        const incomingLocation=options.resolvedLocations?.[person.telegram.id]??person.location;
        const sameCity=old?.location.city&&key(old.location.city)===key(incomingLocation.city);
        const location=!incomingLocation.city&&old?.location.city?old.location:sameCity&&old?.location.lat!==null&&old?.location.lng!==null?old!.location:incomingLocation;
        user={...(old??{}),id,name:old?.name??person.name,
          ...(old?.username||person.telegram.username?{username:old?.username||person.telegram.username!}:{}),role:old?.role??'member',
          callsign:old?.callsign||person.callsign,bio:mergeBio(old?.bio??'',person.bio),location:{...location},
          tags:grouped.canonical([...(old?.tags??[]),...person.tagNames.map(name=>({id:'',name}))]),
          facts:mergeEntries(old?.facts??[],person.facts,`${id}:facts`),achievements:mergeEntries(old?.achievements??[],person.achievements,`${id}:achievements`),
          interests:old?.interests??[],initials:old?.initials??person.name.split(/\s+/u).slice(0,2).map(s=>s[0]).join('').toUpperCase(),color:old?.color??'#b57439',
          stats:old?.stats??{events:0,challenges:0,books:0},joinedAt:old?.joinedAt??person.latestIntroductionPublishedAt,
          communityImport:{importer:'telegram-introductions',version:1,sourceHash:options.sourceHash,sourcePersonId:person.id,telegramId:person.telegram.id,sourceMessageIds:person.sourceMessageIds,importedAt:options.importedAt,...(old?.location.city&&JSON.stringify(old.location)!==JSON.stringify(location)?{previousLocation:old.location}:{})},
        };
        profileSchema.parse({name:user.name,callsign:user.callsign,bio:user.bio,location:user.location,facts:user.facts,achievements:user.achievements,tags:user.tags,interests:user.interests});
      }
      if(!old){user.publicId=allocateUserPublicId(state);state.users.push(user);report.created++;}
      else{const position=state.users.findIndex(u=>u.id===id);state.users[position]=user;}
      if(!state.telegramUsers[person.telegram.id]){state.telegramUsers[person.telegram.id]=id;report.authBindingsAdded++;}
      if(method==='telegram_id')report.matchedByTelegramId++;
      if(method==='username')report.matchedByUsername++;
      if(method==='full_name')report.matchedByFullName++;
      const changed=old&&JSON.stringify(old)!==JSON.stringify(user);
      if(old){if(changed)report.updated++;else report.unchanged++;}
      report.decisions.push({telegramId:person.telegram.id,sourceName:person.name,userId:id,...(old?{existingName:old.name}:{}),method,status:!old?'created':changed?'updated':'unchanged'});
    }catch(error){conflict(person,error instanceof TelegramImportError?error.code:'PROFILE_LIMIT_OR_VALIDATION',existing?[existing]:[],error instanceof z.ZodError?error.issues.map(i=>`${i.path.join('.')}: ${i.message}`).join('; '):String(error));}
  }
  for(const user of state.users){const tags=grouped.canonical(user.tags);if(JSON.stringify(tags)!==JSON.stringify(user.tags))report.profilesRetagged++;user.tags=tags;}
  for(const entity of state.entities){entity.tags=grouped.canonical(entity.tags);for(const p of entity.participants)p.user.tags=grouped.canonical(p.user.tags);if(entity.author)entity.author.tags=grouped.canonical(entity.author.tags);for(const reader of entity.readers??[])reader.tags=grouped.canonical(reader.tags);for(const result of entity.results??[])result.user.tags=grouped.canonical(result.user.tags);}
  const used=new Set([...state.users.flatMap(u=>u.tags.map(t=>t.id)),...embeddedUsers(state).flatMap(u=>u.tags.map(t=>t.id)),...state.entities.flatMap(e=>e.tags.map(t=>t.id))]);
  state.tags=[...grouped.catalog.values()].filter(t=>used.has(t.id)).sort((a,b)=>a.name.localeCompare(b.name,'ru'));
  report.usersAfter=state.users.length;report.tagsAfter=state.tags.length;report.unmappedTags=[...grouped.unmapped].sort((a,b)=>a.localeCompare(b,'ru'));
  return {state,report};
}

/** Mutate only after all validations; Repository.write supplies the database transaction. */
export function applyTelegramImport(state:DatabaseState,source:unknown,mapping:TagGrouping,options:TelegramImportOptions&{skipConflicts?:boolean}):TelegramImportReport{
  const plan=planTelegramImport(state,source,mapping,options);
  if(plan.report.conflicts.length&&!options.skipConflicts)throw new TelegramImportError('IMPORT_CONFLICTS',`${plan.report.conflicts.length} unresolved profiles. Inspect the dry-run report; no changes were applied.`);
  Object.assign(state,plan.state);
  return plan.report;
}
