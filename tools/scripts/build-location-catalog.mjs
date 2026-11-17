import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
if (!process.argv[2]) throw new Error('Usage: node tools/scripts/build-location-catalog.mjs <GeoNames source directory>');
const source = resolve(root, process.argv[2]);
const destination = join(root, 'data', 'location-catalog');
const countryText = await readFile(join(source, 'countryInfo.txt'), 'utf8');
const cityText = await readFile(join(source, 'cities15000.txt'), 'utf8');
const russianNameText = await readFile(join(source, 'ru-city-names.json'), 'utf8').catch(error => {
  if (error.code !== 'ENOENT') throw error;
  return readFile(join(destination, 'russian-names.json'), 'utf8');
});
const russianNames = JSON.parse(russianNameText);
if (!['524901', '498817', '625144'].every(id => russianNames.names?.[id]?.name)) {
  throw new Error('Verified Russian city names for Moscow, Saint Petersburg and Minsk are required.');
}
const names = new Intl.DisplayNames(['ru'], { type: 'region' });
const aliases = {
  RU: ['Российская Федерация', 'Russian Federation'], BY: ['Белоруссия', 'Republic of Belarus'],
  GB: ['Великобритания', 'United Kingdom', 'UK'], US: ['США', 'Соединенные Штаты Америки', 'USA'],
  KR: ['Южная Корея', 'Republic of Korea'], AE: ['ОАЭ', 'United Arab Emirates'],
  CZ: ['Чешская Республика', 'Czech Republic'], TR: ['Турция', 'Turkey', 'Türkiye'],
};
const countries = countryText.split(/\r?\n/).filter(line => line && !line.startsWith('#')).map(line => line.split('\t'))
  .filter(parts => /^[A-Z]{2}$/.test(parts[0]) && !['AN', 'CS'].includes(parts[0]))
  .map(parts => ({ code: parts[0], name: names.of(parts[0]) || parts[4], aliases: [...new Set([parts[0], parts[1], parts[4], ...(aliases[parts[0]] || [])])] }))
  .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
const byCountry = new Map(countries.map(country => [country.code, []]));
let cityCount = 0;
let translatedCount = 0;
for (const line of cityText.split(/\r?\n/)) {
  if (!line) continue;
  const fields = line.split('\t');
  const country = byCountry.get(fields[8]);
  if (!country) continue;
  const latitude = Number(fields[4]), longitude = Number(fields[5]);
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) throw new Error(`Invalid coordinates for GeoNames ID ${fields[0]}`);
  const russian = russianNames.names[fields[0]];
  if (russian) translatedCount++;
  country.push({ id: fields[0], name: russian?.name || fields[1], aliases: [...new Set([fields[1], fields[2], ...fields[3].split(',')])].filter(name => name && name.length <= 100), lat: latitude, lng: longitude, region: fields[10], population: Number(fields[14]) || 0 });
  cityCount++;
}
await mkdir(destination, { recursive: true });
await writeFile(join(destination, 'countries.json'), JSON.stringify(countries), 'utf8');
await writeFile(join(destination, 'russian-names.json'), russianNameText, 'utf8');
for (const [code, cities] of byCountry) {
  cities.sort((a, b) => b.population - a.population || a.name.localeCompare(b.name));
  await writeFile(join(destination, `${code}.json`), JSON.stringify(cities), 'utf8');
}
const metadata = {
  source: 'GeoNames', license: 'CC BY 4.0', attribution: 'Geographical data from GeoNames (https://www.geonames.org/), licensed under CC BY 4.0.',
  urls: ['https://download.geonames.org/export/dump/countryInfo.txt', 'https://download.geonames.org/export/dump/cities15000.zip'],
  countries: countries.length, cities: cityCount, russianCityNames: translatedCount, russianNameSources: russianNames.sources,
  sha256: { countryInfo: createHash('sha256').update(countryText).digest('hex'), cities15000: createHash('sha256').update(cityText).digest('hex') },
};
await writeFile(join(destination, 'source.json'), JSON.stringify(metadata, null, 2), 'utf8');
console.log(JSON.stringify({ countries: countries.length, cities: cityCount, russianCityNames: translatedCount, destination }));
