import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { addActivity } from './domain.js';
import type { Activity } from './shared/contracts.js';
import { requireCapability } from './access.js';
import type { Repository } from './repository.js';
import { z } from 'zod';
import type { LocationCity, LocationCountry } from './shared/location-catalog.js';
import { HttpError } from './errors.js';

interface StoredCity extends Omit<LocationCity, 'countryCode'> { aliases: string[] }
export type LocationOverride =
  | { id: string; scope: 'countries'; country: LocationCountry }
  | { id: string; scope: string; city: StoredCity };
const countryCode = z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/, 'Укажите двухбуквенный код страны');
const placeName = z.string().trim().min(1).max(100);
const countryInput = z.object({ code: countryCode, name: placeName }).strict();
const cityInput = z.object({ name: placeName, region: z.string().trim().max(100),
  lat: z.number().min(-90).max(90).nullable(), lng: z.number().min(-180).max(180).nullable() }).strict()
  .refine(city => (city.lat === null) === (city.lng === null), 'Укажите обе координаты или оставьте обе пустыми');
const querySchema = z.object({
  country: countryCode,
  page: z.coerce.number().int().min(1).max(100000).default(1),
  q: z.string().trim().max(100).default(''),
  limit: z.coerce.number().int().min(1).max(100).default(40),
});
const normalize = (value: string) => value.normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase('ru').replaceAll('ё', 'е').replace(/\s+/g, ' ').trim();

function defaultDirectory() {
  // Both src/location-catalog.ts and dist/location-catalog.js are one level below the Project directory.
  return fileURLToPath(new URL('../data/location-catalog/', import.meta.url));
}

/** Only the requested country is loaded. Keep at most eight country files in memory. */
export class LocationCatalog {
  private countryList?: Promise<LocationCountry[]>;
  private citiesByCountry = new Map<string, Promise<StoredCity[]>>();
  constructor(private directory = defaultDirectory()) {}

  private baseCountries(): Promise<LocationCountry[]> {
    this.countryList ??= readFile(join(this.directory, 'countries.json'), 'utf8').then(text => JSON.parse(text) as LocationCountry[]).catch(error => { this.countryList = undefined; throw error; });
    return this.countryList;
  }

  async countries(overrides: LocationOverride[] = []): Promise<LocationCountry[]> {
    const countries = await this.baseCountries();
    if (!overrides.length) return countries;
    const byCode = new Map(countries.map(country => [country.code, country]));
    for (const row of overrides) if ('country' in row) byCode.set(row.country.code, row.country);
    return [...byCode.values()].sort((a,b) => a.name.localeCompare(b.name, 'ru'));
  }

  private async loadCities(country: string, overrides: LocationOverride[]): Promise<StoredCity[]> {
    if (!/^[A-Z]{2}$/.test(country) || !(await this.countries(overrides)).some(item => item.code === country)) {
      throw new HttpError(400, 'UNKNOWN_COUNTRY', 'Выберите страну из справочника');
    }
    if (!(await this.baseCountries()).some(item => item.code === country)) return [];
    let pending = this.citiesByCountry.get(country);
    if (pending) { this.citiesByCountry.delete(country); this.citiesByCountry.set(country, pending); return pending; }
    pending = readFile(join(this.directory, `${country}.json`), 'utf8').then(text => JSON.parse(text) as StoredCity[])
      .catch(error => { this.citiesByCountry.delete(country); throw error; });
    this.citiesByCountry.set(country, pending);
    if (this.citiesByCountry.size > 8) this.citiesByCountry.delete(this.citiesByCountry.keys().next().value!);
    return pending;
  }

  private async cityEntries(country: string, overrides: LocationOverride[]) {
    const base = await this.loadCities(country, overrides);
    const custom = overrides.filter(row => row.scope === country && 'city' in row);
    if (!custom.length) return base;
    const merged = new Map(base.map(city => [city.id, city]));
    for (const row of custom) if ('city' in row) merged.set(row.city.id, row.city);
    return [...merged.values()];
  }

  async saveCountry(overrides: LocationOverride[], input: unknown, original?: string) {
    const { code, name } = countryInput.parse(input);
    const countries = await this.countries(overrides);
    const prior = countries.find(entry => entry.code === (original ?? code));
    if (original && !prior) throw new HttpError(404, 'NOT_FOUND', 'Страна не найдена');
    if (original && original !== code) throw new HttpError(400, 'COUNTRY_CODE', 'Код сохранённой страны нельзя изменить');
    if ((!original && prior) || countries.some(entry => entry.code !== code &&
      [entry.name, entry.code, ...entry.aliases].some(alias => normalize(alias) === normalize(name)))) {
      throw new HttpError(409, 'COUNTRY_EXISTS', 'Страна с таким кодом или названием уже есть');
    }
    const country = { code, name, aliases: [...new Set([...(prior?.aliases ?? []), ...(prior ? [prior.name] : [])])].filter(alias => alias !== name) };
    this.store(overrides, { id: 'country:' + code, scope: 'countries', country });
    return country;
  }

  async saveCity(overrides: LocationOverride[], code: string, input: unknown, id?: string) {
    const country = countryCode.parse(code);
    const values = cityInput.parse(input);
    const cities = await this.cityEntries(country, overrides);
    const prior = id ? cities.find(city => city.id === id) : undefined;
    if (id && !prior) throw new HttpError(404, 'NOT_FOUND', 'Город не найден');
    if ((!prior || values.name !== prior.name || values.region !== prior.region) && cities.some(city => city.id !== id
      && normalize(city.name) === normalize(values.name) && normalize(city.region) === normalize(values.region))) {
      throw new HttpError(409, 'CITY_EXISTS', 'Город с таким названием в этом регионе уже есть');
    }
    const city = { ...values, id: id ?? randomUUID(), population: prior?.population ?? 0,
      aliases: [...new Set([...(prior?.aliases ?? []), ...(prior ? [prior.name] : [])])].filter(alias => alias !== values.name) };
    this.store(overrides, { id: 'city:' + country + ':' + city.id, scope: country, city });
    return { ...values, id: city.id, population: city.population, countryCode: country };
  }

  private store(overrides: LocationOverride[], row: LocationOverride) {
    const index = overrides.findIndex(existing => existing.id === row.id);
    if (index < 0) overrides.push(row);
    else overrides[index] = row;
  }

  async cities(input: unknown, overrides: LocationOverride[] = []) {
    const { country, q, limit, page } = querySchema.parse(input);
    const cities = await this.cityEntries(country, overrides);
    const query = normalize(q);
    const matches = cities.flatMap(city => {
      if (!query) return [{ city, rank: 0 }];
      const names = [city.name, ...city.aliases];
      const exact = names.find(name => normalize(name) === query);
      if (exact) return [{ city, rank: 0 }];
      const prefix = names.find(name => normalize(name).startsWith(query));
      if (prefix) return [{ city, rank: 1 }];
      const partial = names.find(name => normalize(name).includes(query));
      return partial ? [{ city, rank: 2 }] : [];
    }).sort((a, b) => a.rank - b.rank || b.city.population - a.city.population || a.city.name.localeCompare(b.city.name));
    return {
      data: matches.slice((page - 1) * limit, page * limit).map(({ city }) => ({ id: city.id, name: city.name, countryCode: country, region: city.region, lat: city.lat, lng: city.lng, population: city.population })),
      meta: { total: matches.length, limit, page, pages: Math.max(1, Math.ceil(matches.length / limit)) },
    };
  }
}

/** Mount after requireAuth so the catalog follows the closed-community access policy. */
export function createLocationCatalogRouter(repo: Repository, notify: (activity: Activity) => void) {
  const catalog = new LocationCatalog();
  const router = Router();
  const overrides = (...scopes: string[]) => repo.locationOverrides ? repo.locationOverrides(scopes)
    : repo.read(state => state.locationOverrides.filter(row => scopes.includes(row.scope)));
  router.get('/countries', async (_req, res) => res.json({ data: await catalog.countries(await overrides('countries')) }));
  router.get('/cities', async (req, res) => {
    const params = querySchema.parse(req.query);
    res.json(await catalog.cities(params, await overrides('countries', params.country)));
  });
  router.use((req, _res, next) => { requireCapability(req.user!, 'catalog.manage'); next(); });
  for (const method of ['post', 'patch'] as const) {
    const suffix = method === 'patch' ? '/:id' : '';
    router[method]('/countries' + suffix, async (req, res) => {
      const { data, activity } = await repo.write(async state => {
        const data = await catalog.saveCountry(state.locationOverrides, req.body, req.params.id as string | undefined);
        return { data, activity:addActivity(state, req.user!, (method === 'post' ? 'добавил страну' : 'изменил страну') + ' «' + data.name + '»') };
      });
      notify(activity);
      res.status(method === 'post' ? 201 : 200).json({ data });
    });
    router[method]('/countries/:code/cities' + suffix, async (req, res) => {
      const { data, activity } = await repo.write(async state => {
        const data = await catalog.saveCity(state.locationOverrides, String(req.params.code), req.body, req.params.id as string | undefined);
        return { data, activity:addActivity(state, req.user!, (method === 'post' ? 'добавил город' : 'изменил город') + ' «' + data.name + '»') };
      });
      notify(activity);
      res.status(method === 'post' ? 201 : 200).json({ data });
    });
  }
  return router;
}
