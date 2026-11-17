import { config as loadEnv } from 'dotenv';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { backendRoot, privateOutputPath } from '../paths.js';
import { PostgresRepository } from '../../src/repository.js';
import { planTelegramImport, TelegramImportError, type TagGrouping } from './telegram-import.js';
import { resolveTelegramImportLocations } from './telegram-import-locations.js';

function argumentsFor(argv:string[]){
  const flags=new Set(['--apply','--skip-conflicts']);
  const values=new Set(['--file','--mapping','--database-env','--report','--backup-file','--matches','--new-ids','--defer-ids']);
  const result:Record<string,string|boolean>={};
  for(let index=0;index<argv.length;index++){
    const arg=argv[index]!;
    if(flags.has(arg)){result[arg]=true;continue;}
    if(!values.has(arg)||!argv[index+1]||argv[index+1]!.startsWith('--'))throw new Error(`Unknown or incomplete argument: ${arg}`);
    result[arg]=argv[++index]!;
  }
  if(!['DATABASE_URL','DEMO_DATABASE_URL'].includes(String(result['--database-env'])))throw new Error('Choose --database-env DATABASE_URL or DEMO_DATABASE_URL explicitly');
  if(!result['--file'])throw new Error('Choose --file <prepared-community.json> explicitly');
  if(result['--apply']&&!result['--backup-file'])throw new Error('--apply requires --backup-file .local/backups/<unique-name>.json (or an external absolute path)');
  return result;
}
function parseMapping(value:unknown):TagGrouping{
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Tag mapping must be a JSON object');
  const object=value as Record<string,unknown>;
  const direct=(object.mapping??object) as Record<string,unknown>;
  if(Object.values(direct).every(v=>typeof v==='string'))return direct as TagGrouping;
  if(Array.isArray(object.groups)){
    const mapping:TagGrouping={};
    for(const group of object.groups){
      if(!group||typeof group!=='object'||typeof group.name!=='string'||!Array.isArray(group.aliases))throw new Error('Invalid tag group');
      mapping[group.name]=group.name;
      for(const alias of group.aliases){if(typeof alias!=='string')throw new Error('Invalid tag alias');mapping[alias]=group.name;}
    }
    return mapping;
  }
  throw new Error('Expected a tag-name mapping or groups with name and aliases');
}
async function writeJson(file:string,value:unknown,exclusive=false){await mkdir(dirname(file),{recursive:true});await writeFile(file,JSON.stringify(value,null,2)+'\n',{encoding:'utf8',flag:exclusive?'wx':'w'});}

async function main(){
  const args=argumentsFor(process.argv.slice(2));
  const root=backendRoot;
  loadEnv({path:resolve(root,process.env.DOTENV_CONFIG_PATH || '.env'),quiet:true});
  const sourceFile=resolve(root,String(args['--file']));
  const mappingFile=resolve(root,String(args['--mapping']??'tools/importers/data/community-tag-groups.json'));
  const reportFile=privateOutputPath(String(args['--report']??'.local/imports/telegram-import-report.json'));
  const backupFile=args['--backup-file']?privateOutputPath(String(args['--backup-file'])):undefined;
  const databaseEnv=String(args['--database-env']);
  const connection=process.env[databaseEnv];
  if(!connection)throw new Error(`${databaseEnv} is not configured`);
  let database:string;
  try{database=new URL(connection).pathname.replace(/^\//,'');}catch{throw new Error(`${databaseEnv} is not a valid database URL`);}
  const bytes=await readFile(sourceFile);
  const source=JSON.parse(bytes.toString('utf8'));
  const mapping=parseMapping(JSON.parse(await readFile(mappingFile,'utf8')));
  const reviewedMatches=args['--matches']?JSON.parse(await readFile(resolve(root,String(args['--matches'])),'utf8')) as Record<string,string>:undefined;
  if(reviewedMatches&&(!reviewedMatches||typeof reviewedMatches!=='object'||Array.isArray(reviewedMatches)||Object.values(reviewedMatches).some(v=>typeof v!=='string')))throw new Error('--matches must contain an object mapping Telegram IDs to reviewed existing User IDs');
  const reviewedNewIds=args['--new-ids']?JSON.parse(await readFile(resolve(root,String(args['--new-ids'])),'utf8')) as string[]:undefined;
  if(reviewedNewIds&&(!Array.isArray(reviewedNewIds)||reviewedNewIds.some(id=>typeof id!=='string'||!/^\d+$/.test(id))))throw new Error('--new-ids must contain an array of reviewed Telegram ID strings');
  const deferredTelegramIds=args['--defer-ids']?JSON.parse(await readFile(resolve(root,String(args['--defer-ids'])),'utf8')) as string[]:undefined;
  if(deferredTelegramIds&&(!Array.isArray(deferredTelegramIds)||deferredTelegramIds.some(id=>typeof id!=='string'||!/^\d+$/.test(id))))throw new Error('--defer-ids must contain an array of Telegram ID strings requiring identity review');
  const geocoding=await resolveTelegramImportLocations(source.people,resolve(root,'data/location-catalog'));
  const options={sourceHash:createHash('sha256').update(bytes).digest('hex'),importedAt:new Date().toISOString(),...(reviewedMatches?{reviewedMatches}:{}),...(reviewedNewIds?{reviewedNewIds}:{}),...(deferredTelegramIds?{deferredTelegramIds}:{}),resolvedLocations:geocoding.locations};
  const reportMetadata={database,databaseEnv,sourceFile:basename(sourceFile),sourceHash:options.sourceHash,importedAt:options.importedAt,geocoding:{resolved:Object.keys(geocoding.locations).length,unresolved:geocoding.unresolved}};
  const repo=new PostgresRepository(connection);
  try{
    // The application owns migrations; importing cannot quietly create an empty database schema.
    const apply=Boolean(args['--apply']);
    const report=apply?await repo.write(async state=>{
      const plan=planTelegramImport(state,source,mapping,options);
      await writeJson(reportFile,{mode:'pre-apply',...reportMetadata,...plan.report});
      if(plan.report.conflicts.length&&!args['--skip-conflicts'])throw new TelegramImportError('IMPORT_CONFLICTS',`${plan.report.conflicts.length} unresolved profiles; inspect ${reportFile}. No changes applied.`);
      await writeJson(backupFile!,{format:'klan-database-state-v1',database,createdAt:options.importedAt,state},true);
      Object.assign(state,plan.state);
      return plan.report;
    }):await repo.read(state=>planTelegramImport(state,source,mapping,options).report);
    await writeJson(reportFile,{mode:apply?'applied':'dry-run',...reportMetadata,...report});
    const {decisions,conflicts,...summary}=report;
    console.log(JSON.stringify({mode:apply?'applied':'dry-run',database,reportFile,...(apply?{backupFile}:{}),...summary,geocoded:Object.keys(geocoding.locations).length,unresolvedLocations:geocoding.unresolved.length,conflicts:conflicts.length,conflictCodes:[...new Set(conflicts.map(c=>c.code))]},null,2));
  }finally{await repo.close();}
}
main().catch(error=>{console.error(error instanceof TelegramImportError?`${error.code}: ${error.message}`:error instanceof Error?error.message:'Import failed');process.exitCode=1;});
