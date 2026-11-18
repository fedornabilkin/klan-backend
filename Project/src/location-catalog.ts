import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Router } from 'express';
import { z } from 'zod';
import type { LocationCity, LocationCountry } from './shared/location-catalog.js';
import { HttpError } from './errors.js';

interface StoredCity extends Omit<LocationCity, 'countryCode'> { aliases: string[] }
const querySchema = z.object({
  country: z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/),
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

  countries(): Promise<LocationCountry[]> {
    this.countryList ??= readFile(join(this.directory, 'countries.json'), 'utf8').then(text => JSON.parse(text) as LocationCountry[]).catch(error => { this.countryList = undefined; throw error; });
    return this.countryList;
  }

  private async loadCities(country: string): Promise<StoredCity[]> {
    if (!/^[A-Z]{2}$/.test(country) || !(await this.countries()).some(item => item.code === country)) {
      throw new HttpError(400, 'UNKNOWN_COUNTRY', 'Выберите страну из справочника');
    }
    let pending = this.citiesByCountry.get(country);
    if (pending) { this.citiesByCountry.delete(country); this.citiesByCountry.set(country, pending); return pending; }
    pending = readFile(join(this.directory, `${country}.json`), 'utf8').then(text => JSON.parse(text) as StoredCity[])
      .catch(error => { this.citiesByCountry.delete(country); throw error; });
    this.citiesByCountry.set(country, pending);
    if (this.citiesByCountry.size > 8) this.citiesByCountry.delete(this.citiesByCountry.keys().next().value!);
    return pending;
  }

  async cities(input: unknown): Promise<{ data: LocationCity[]; meta: { total: number; limit: number } }> {
    const { country, q, limit } = querySchema.parse(input);
    const cities = await this.loadCities(country);
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
      data: matches.slice(0, limit).map(({ city }) => ({ id: city.id, name: city.name, countryCode: country, region: city.region, lat: city.lat, lng: city.lng, population: city.population })),
      meta: { total: matches.length, limit },
    };
  }
}

/** Mount after requireAuth so the catalog follows the closed-community access policy. */
export function createLocationCatalogRouter(catalog = new LocationCatalog()) {
  const router = Router();
  router.get('/countries', async (_req, res) => res.json({ data: await catalog.countries() }));
  router.get('/cities', async (req, res) => res.json(await catalog.cities(req.query)));
  return router;
}
