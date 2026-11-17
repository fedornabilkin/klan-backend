import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import type {Location} from '../../src/shared/contracts.js';
import type {LocationCountry} from '../../src/shared/location-catalog.js';

interface CatalogCity {id:string;name:string;aliases:string[];lat:number;lng:number}
interface SourcePerson {telegram:{id:string};location:{city:string;country:string}}
const key=(v:string)=>v.normalize('NFKD').replace(/\p{M}/gu,'').toLocaleLowerCase('ru').replaceAll('ё','е').replace(/\s+/gu,' ').trim();
const cityKey=(v:string)=>key(v).replace(/^г(?:ород)?\.?\s+/u,'');
/** Exact names and recorded aliases only. No network, coordinates for homes, or fuzzy geocoding. */
export async function resolveTelegramImportLocations(people:SourcePerson[],directory:string){
  const countries=JSON.parse(await readFile(join(directory,'countries.json'),'utf8')) as LocationCountry[];
  const requested=new Set(people.map(p=>cityKey(p.location.city)).filter(Boolean));
  const index=new Map<string,{city:CatalogCity;country:LocationCountry;primary:boolean}[]>();
  for(const country of countries){
    let cities:CatalogCity[];
    try{cities=JSON.parse(await readFile(join(directory,`${country.code}.json`),'utf8'));}
    catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')continue;throw error;}
    for(const city of cities)for(const alias of new Set([city.name,...city.aliases].map(cityKey))){
      if(!requested.has(alias))continue;
      index.set(alias,[...(index.get(alias)??[]),{city,country,primary:cityKey(city.name)===alias}]);
    }
  }
  const locations:Record<string,Location>={};
  const unresolved:{telegramId:string;city:string;country:string;reason:string}[]=[];
  for(const person of people){
    const city=cityKey(person.location.city),country=key(person.location.country);
    if(!city){unresolved.push({telegramId:person.telegram.id,...person.location,reason:'city_not_stated'});continue;}
    let matches=index.get(city)??[];
    if(country){
      const countryCodes=new Set(countries.filter(c=>[c.name,...c.aliases].some(a=>key(a)===country)).map(c=>c.code));
      matches=matches.filter(m=>countryCodes.has(m.country.code));
    }
    const primary=matches.filter(m=>m.primary);
    if(primary.length===1)matches=primary;
    const distinct=[...new Map(matches.map(m=>[m.country.code+':'+m.city.id,m])).values()];
    if(distinct.length===1){const {city, country}=distinct[0]!;locations[person.telegram.id]={city:city.name,country:country.name,lat:city.lat,lng:city.lng};}
    else unresolved.push({telegramId:person.telegram.id,...person.location,reason:distinct.length?'ambiguous_city':'not_found_in_local_catalog'});
  }
  return {locations,unresolved};
}
