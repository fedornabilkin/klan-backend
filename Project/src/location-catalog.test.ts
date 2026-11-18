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
  assert.ok(moscow.data[0]!.lat > 55 && moscow.data[0]!.lat < 56);
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
