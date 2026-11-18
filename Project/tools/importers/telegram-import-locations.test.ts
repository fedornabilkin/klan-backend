import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {resolveTelegramImportLocations} from './telegram-import-locations.js';

test('local city resolver accepts exact aliases and leaves ambiguous, absent and multiple cities unresolved',async()=>{
  const make=(id:string,city:string,country:string)=>({telegram:{id},location:{city,country}});
  const result=await resolveTelegramImportLocations([
    make('1','Москва','Россия'),make('2','Moscow','RU'),make('3','Киров','Россия'),
    make('4','Москва / Санкт-Петербург','Россия'),make('5','','Россия'),make('6','Город которого нет','Россия'),
  ],fileURLToPath(new URL('../../data/location-catalog/',import.meta.url)));
  assert.equal(result.locations['1']?.city,'Москва');
  assert.deepEqual(result.locations['2'],result.locations['1']);
  assert.ok(result.locations['1']!.lat!>55&&result.locations['1']!.lat!<56);
  assert.deepEqual(result.unresolved.map(x=>[x.telegramId,x.reason]),[
    ['3','ambiguous_city'],['4','not_found_in_local_catalog'],['5','city_not_stated'],['6','not_found_in_local_catalog'],
  ]);
});
