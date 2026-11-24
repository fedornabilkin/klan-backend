import test from 'node:test';
import assert from 'node:assert/strict';
import { LocationCatalog } from './location-catalog.js';

test('country catalog includes all current ISO countries and preserves Russian and imported aliases', async () => {
  const countries = await new LocationCatalog().countries();
  assert.equal(countries.length, 250); // 249 ISO entries plus GeoNames' XK.
  assert.equal(new Set(countries.map(country => country.code)).size, countries.length);
  assert.equal(countries.find(country => country.code === 'RU')!.name, 'Россия');
  assert.ok(countries.find(country => country.code === 'GB')!.aliases.includes('United Kingdom'));
  assert.ok(!countries.some(country => ['AN', 'CS'].includes(country.code)));
});

test('city search is country-scoped, understands Cyrillic aliases, and returns real coordinates', async () => {
  const catalog = new LocationCatalog();
  const moscow = await catalog.cities({ country: 'RU', q: 'Москва' });
  assert.equal(moscow.data[0]!.name, 'Москва');
  assert.equal(moscow.data[0]!.id, '524901');
  const latitude = moscow.data[0]!.lat;
  assert.ok(latitude !== null && latitude > 55 && latitude < 56);
  assert.ok(moscow.data.every(city => city.countryCode === 'RU'));
  assert.equal((await catalog.cities({ country: 'RU', q: 'Moscow' })).data[0]!.name, 'Москва');
  assert.equal((await catalog.cities({ country: 'RU', q: 'Leningrad' })).data[0]!.name, 'Санкт-Петербург');
  const initial = await catalog.cities({ country: 'RU', limit: 2 });
  assert.deepEqual(initial.data.map(city => city.name), ['Москва', 'Санкт-Петербург']);
  assert.equal((await catalog.cities({ country: 'BY', q: 'Minsk' })).data[0]!.name, 'Минск');
  const german = await catalog.cities({ country: 'DE', q: 'Berlin' });
  assert.equal(german.data[0]!.id, '2950159');
  assert.ok(german.data.every(city => city.countryCode === 'DE'));
  assert.equal((await catalog.cities({ country: 'RU', q: 'Неизвестный город 123456' })).data.length, 0);
});

test('country input cannot become a filesystem path and result count stays bounded', async () => {
  const catalog = new LocationCatalog();
  await assert.rejects(catalog.cities({ country: '../countries' }));
  await assert.rejects(catalog.cities({ country: 'ZZ' }), { code: 'UNKNOWN_COUNTRY' });
  await assert.rejects(catalog.cities({ country: 'RU', limit: 10000 }));
  const cities = await catalog.cities({ country: 'US', limit: 5 });
  assert.equal(cities.data.length, 5);
  assert.ok(cities.meta.total > 5);
});

test('редактирование географии сохраняет идентификаторы, алиасы, границы стран и пагинацию', async () => {
  const catalog = new LocationCatalog();
  const overrides: import('./location-catalog.js').LocationOverride[] = [];
  await catalog.saveCountry(overrides, {code:'ZZ', name:'Новая страна'});
  await assert.rejects(catalog.saveCountry(overrides, {code:'ZZ', name:'Другая'}), {code:'COUNTRY_EXISTS'});
  await catalog.saveCountry(overrides, {code:'ZZ', name:'Новое название'}, 'ZZ');
  assert.ok((await catalog.countries(overrides)).find(c => c.code === 'ZZ')?.aliases.includes('Новая страна'));
  const fields = {name:'Маяк', region:'Север', lat:null, lng:null};
  const first = await catalog.saveCity(overrides,'ZZ',fields);
  await assert.rejects(catalog.saveCity(overrides,'ZZ',fields), {code:'CITY_EXISTS'});
  const updated = await catalog.saveCity(overrides,'ZZ',{...fields,name:'Новый маяк',lat:0,lng:0},first.id);
  assert.equal(updated.id,first.id);
  assert.equal((await catalog.cities({country:'ZZ',q:'Маяк'},overrides)).data[0]?.lat,0);
  await assert.rejects(catalog.saveCity(overrides,'RU',fields,first.id), {code:'NOT_FOUND'});
  await assert.rejects(catalog.saveCity(overrides,'ZZ',{...fields,lng:1}));
  await catalog.saveCity(overrides,'ZZ',{...fields, name:'Южный'});
  const page = await catalog.cities({country:'ZZ',page:2,limit:1},overrides);
  assert.equal(page.meta.total,2); assert.equal(page.data.length,1);
  const moscow = (await catalog.cities({country:'RU',q:'Москва'})).data[0]!;
  await catalog.saveCity(overrides,'RU',{name:'Москва обновлённая',region:moscow.region,lat:0,lng:0},moscow.id);
  assert.equal((await catalog.cities({country:'RU',q:'Moscow'},overrides)).data[0]?.name,'Москва обновлённая');
});
