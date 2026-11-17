import { createHash } from 'node:crypto';
import type { Tag, User } from '../../src/shared/contracts.js';
import { normalizeProfileEntries } from '../../src/shared/profile-entries.js';
import type { DatabaseState } from '../../src/repository.js';

export interface SourceInfo { sourceHash: string; importedAt: string; sourceName?: string }
export interface NetworkSelfIdentity { name: string; username: string }
export interface NetworkEnrichment {
  sourceId: string | number;
  city?: string | null; country?: string | null; evidence?: string | null; certainty?: string;
  interests?: string[]; achievements?: string[]; notes?: string | string[];
  lat?: number | null; lng?: number | null; geonameId?: number | string | null;
}
export interface ImportProvenance {
  importer: 'pcm-helper'; version: 1; sourceHash: string; sourceName?: string;
  sourceId: string; nodeUid: string; importedAt: string;
}
export interface NetworkImportedProfile extends User { importProvenance: ImportProvenance }
export interface NetworkImportPlan {
  sourceInfo: SourceInfo; profiles: NetworkImportedProfile[]; tags: Tag[];
  summary: {
    sourceNodes: number; selected: number; excluded: number; sourceTags: number; canonicalTags: number; tagsUsed: number;
    primaryContacts: number; linkContacts: number; explicitOverrides: number; mappedLocations: number;
    maxFactLength: number; maxFacts: number;
    exclusions: { sourceId: string; reason: string }[];
  };
}
export interface NetworkImportResult { addedUsers: number; addedTags: number; skippedUsers: number; noop: boolean }
export class NetworkImportError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = 'NetworkImportError'; }
}
const fail = (code: string, message: string): never => { throw new NetworkImportError(code, message); };
type RecordValue = Record<string, unknown>;
function object(value: unknown, field: string): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('INVALID_SOURCE', `Expected object: ${field}`);
  return value as RecordValue;
}
function string(value: unknown, field: string, optional = false): string {
  if (optional && value == null) return '';
  if (typeof value !== 'string') return fail('INVALID_SOURCE', `Expected text: ${field}`);
  return value;
}
function array(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) return fail('INVALID_SOURCE', `Expected array: ${field}`);
  return value;
}
function sourceId(value: unknown): string {
  if ((typeof value !== 'string' && typeof value !== 'number') || !String(value).trim()) return fail('INVALID_SOURCE', 'Missing source ID');
  return String(value);
}
function uid(value: unknown): string {
  const result = string(value, 'node.uid');
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,100}$/.test(result)) return fail('INVALID_SOURCE', 'Invalid stable node UID');
  return result;
}
export const normalizeImportTagName = (value: string): string => value.normalize('NFKC').trim().replace(/\s+/gu, ' ');
const tagKey = (value: string) => normalizeImportTagName(value).toLocaleLowerCase('ru');
const usernameKey = (value: string | undefined) => (value ?? '').trim().replace(/^@/, '').toLowerCase();
const tagId = (key: string) => `pcm-tag-${createHash('sha256').update(key).digest('hex').slice(0, 24)}`;
const channelContext = /(?:канал|блог|channel|blog|чат|группа|group|бот|\bbot\b)/iu;
const personalContext = /(?:личн|личка|профиль|контакт|связаться|telegram|телеграм|\bтг\b|\btg\b)/iu;
const reservedLinks = new Set(['joinchat', 'share', 'addstickers', 'addemoji', 'proxy', 'socks', 'login', 'iv', 'boost']);

/** Source ordering denotes the primary contact; secondary handles remain in the original facts. */
function telegramContact(facts: readonly string[]): { username: string; kind: 'primary' | 'link' } | undefined {
  for (const fact of facts) {
    const pattern = /(?<![\p{L}\p{N}_.@/])@([A-Za-z][A-Za-z0-9_]{4,31})(?![\p{L}\p{N}_@])/gu;
    for (const match of fact.matchAll(pattern)) {
      const preceding = fact.slice(Math.max(0, match.index! - 35), match.index!);
      // A fact containing only a labelled channel is not a personal contact.
      if (channelContext.test(preceding)) continue;
      return { username: match[1]!, kind: 'primary' };
    }
  }
  for (const fact of facts) {
    if (channelContext.test(fact) || !personalContext.test(fact)) continue;
    const pattern = /(?<![\p{L}\p{N}_.@/])(?:https?:\/\/)?t\.me\/([A-Za-z][A-Za-z0-9_]{4,31})(?![\p{L}\p{N}_/?#])/giu;
    for (const match of fact.matchAll(pattern)) {
      const username = match[1]!;
      if (!reservedLinks.has(username.toLowerCase()) && !/bot$/i.test(username)) return { username, kind: 'link' };
    }
  }
  return undefined;
}
function enrichmentStrings(value: string[] | undefined, field: string): string[] {
  if (value === undefined) return [];
  return [...new Set(array(value, field).map(item => string(item, field)).filter(item => item.trim()))];
}
function locationFor(enrichment: NetworkEnrichment | undefined): User['location'] {
  if (!enrichment || !enrichment.evidence?.trim()) return { city: '', country: '', lat: null, lng: null };
  const country = enrichment.country?.trim() ?? '';
  if (enrichment.certainty !== 'explicit') return { city: '', country, lat: null, lng: null };
  const city = enrichment.city?.trim() ?? '';
  const { lat, lng, geonameId } = enrichment;
  const verified = city && country && /^\d+$/.test(String(geonameId ?? '')) && Number(geonameId) > 0
    && typeof lat === 'number' && Number.isFinite(lat) && lat >= -90 && lat <= 90
    && typeof lng === 'number' && Number.isFinite(lng) && lng >= -180 && lng <= 180;
  return { city, country, lat: verified ? lat : null, lng: verified ? lng : null };
}
function validateSourceInfo(value: SourceInfo): SourceInfo {
  if (!/^[a-f0-9]{64}$/i.test(value.sourceHash)) return fail('INVALID_SOURCE_INFO', 'sourceHash must be a SHA-256 hex digest');
  if (!/^\d{4}-\d\d-\d\dT/.test(value.importedAt) || !Number.isFinite(Date.parse(value.importedAt))) return fail('INVALID_SOURCE_INFO', 'importedAt must be the actual ISO import timestamp');
  if (value.sourceName !== undefined && (typeof value.sourceName !== 'string' || /[\\/]/.test(value.sourceName))) return fail('INVALID_SOURCE_INFO', 'sourceName must be a filename, not a path or URL');
  return { sourceHash: value.sourceHash.toLowerCase(), importedAt: value.importedAt, ...(value.sourceName ? { sourceName: value.sourceName } : {}) };
}

/** Pure preparation: no filesystem, database, clock, network or authentication changes. */
export function prepareNetworkImport(source: unknown, enrichments: readonly NetworkEnrichment[], sourceInfo: SourceInfo, selfIdentity?: NetworkSelfIdentity): NetworkImportPlan {
  const info = validateSourceInfo(sourceInfo);
  const payload = object(object(source, 'source').payload, 'payload');
  const nodes = array(payload.nodes, 'nodes');
  const rawTags = array(payload.tags, 'tags');
  const tags: Tag[] = [];
  const canonicalTags = new Map<string, Tag>();
  const tagsBySourceId = new Map<string, Tag>();
  for (const item of rawTags) {
    const raw = object(item, 'tag');
    const id = sourceId(raw.id);
    if (tagsBySourceId.has(id)) fail('DUPLICATE_SOURCE_TAG', `Duplicate source tag ID: ${id}`);
    const name = normalizeImportTagName(string(raw.name, 'tag.name'));
    if (!name || name.length > 80 || /[\u0000-\u001f]/.test(name)) fail('INVALID_SOURCE_TAG', `Invalid source tag: ${id}`);
    const key = tagKey(name);
    let tag = canonicalTags.get(key);
    if (!tag) { tag = { id: tagId(key), name }; tags.push(tag); canonicalTags.set(key, tag); }
    tagsBySourceId.set(id, tag);
  }
  const enrichmentMap = new Map<string, NetworkEnrichment>();
  for (const enrichment of enrichments) {
    const id = sourceId(enrichment.sourceId);
    if (enrichmentMap.has(id)) fail('DUPLICATE_ENRICHMENT', `Duplicate enrichment: ${id}`);
    enrichmentMap.set(id, enrichment);
  }
  const profiles: NetworkImportedProfile[] = [];
  const nodeIds = new Set<string>();
  const nodeUids = new Set<string>();
  const usernames = new Set<string>();
  const summary: NetworkImportPlan['summary'] = { sourceNodes: nodes.length, selected: 0, excluded: 0, sourceTags: rawTags.length, canonicalTags: tags.length, tagsUsed: 0,
    primaryContacts: 0, linkContacts: 0, explicitOverrides: 0, mappedLocations: 0, maxFactLength: 0, maxFacts: 0, exclusions: [] };
  for (const item of nodes) {
    const node = object(item, 'node');
    const id = sourceId(node.id);
    const nodeUid = uid(node.uid);
    if (nodeIds.has(id) || nodeUids.has(nodeUid)) fail('DUPLICATE_SOURCE_NODE', `Duplicate source node: ${id}`);
    nodeIds.add(id); nodeUids.add(nodeUid);
    const originalName = string(node.name, 'node.name');
    const facts = array(node.facts ?? [], 'facts').map(item => string(object(item, 'fact').description, 'fact.description', true)).filter(value => value.trim());
    const self = originalName.trim() === 'Я';
    if (self && (!selfIdentity || !selfIdentity.name.trim() || !/^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(selfIdentity.username))) {
      fail('SELF_IDENTITY_REQUIRED', 'The source self node requires an explicitly reviewed name and Telegram username');
    }
    const contact = self ? { username: selfIdentity!.username, kind: 'override' as const } : telegramContact(facts);
    if (!contact) { summary.exclusions.push({ sourceId: id, reason: 'No unambiguous personal Telegram contact in facts' }); continue; }
    const key = usernameKey(contact.username);
    if (usernames.has(key)) fail('DUPLICATE_USERNAME', `Duplicate selected Telegram username at source node ${id}`);
    usernames.add(key);
    const name = self ? selfIdentity!.name : originalName;
    if (!name.trim() || name.length > 120) fail('INVALID_SOURCE_PROFILE', `Invalid name at source node ${id}`);
    const bio = string(node.description, 'node.description', true);
    if (bio.length > 5000) fail('INVALID_SOURCE_PROFILE', `Bio exceeds profile limit at source node ${id}`);
    const pcm = node.pcm == null ? undefined : object(node.pcm, 'pcm');
    const filter = pcm?.filter == null ? undefined : object(pcm.filter, 'pcm.filter');
    const label = filter ? string(filter.label, 'pcm.filter.label', true).trim() : '';
    if (label) facts.push(`PCM (из исходного файла): ${label}`);
    const enrichment = enrichmentMap.get(id);
    const location = locationFor(enrichment);
    const selectedTags = new Map<string, Tag>();
    for (const value of array(node.tags ?? [], 'node.tags')) {
      const tag = tagsBySourceId.get(sourceId(value));
      if (!tag) fail('UNKNOWN_SOURCE_TAG', `Unknown tag reference at source node ${id}`);
      selectedTags.set(tag!.id, tag!);
    }
    profiles.push({
      id: `pcm-${nodeUid}`, name, username: contact.username, role: 'member', bio, location,
      tags: [...selectedTags.values()].map(tag => ({ ...tag })),
      initials: name.trim().split(/\s+/u).slice(0, 2).map(part => part[0]).join('').toUpperCase(), color: '#b57439',
      facts: normalizeProfileEntries(facts, `pcm-${nodeUid}:facts`),
      interests: enrichmentStrings(enrichment?.interests, 'interests'),
      achievements: normalizeProfileEntries(enrichmentStrings(enrichment?.achievements, 'achievements'), `pcm-${nodeUid}:achievements`),
      stats: { events: 0, challenges: 0, books: 0 }, joinedAt: info.importedAt,
      importProvenance: { importer: 'pcm-helper', version: 1, sourceHash: info.sourceHash, sourceName: info.sourceName, sourceId: id, nodeUid, importedAt: info.importedAt },
    });
    if (contact.kind === 'primary') summary.primaryContacts++;
    else if (contact.kind === 'link') summary.linkContacts++;
    else summary.explicitOverrides++;
    if (location.lat !== null && location.lng !== null) summary.mappedLocations++;
    summary.maxFactLength = Math.max(summary.maxFactLength, ...facts.map(fact => fact.length));
    summary.maxFacts = Math.max(summary.maxFacts, facts.length);
  }
  for (const id of enrichmentMap.keys()) if (!nodeIds.has(id)) fail('UNKNOWN_ENRICHMENT', `Enrichment references absent source node: ${id}`);
  summary.selected = profiles.length;
  summary.excluded = nodes.length - profiles.length;
  const usedIds = new Set(profiles.flatMap(profile => profile.tags.map(tag => tag.id)));
  const usedTags = tags.filter(tag => usedIds.has(tag.id));
  summary.tagsUsed = usedTags.length;
  return { sourceInfo: info, profiles, tags: usedTags, summary };
}

/** Validate every conflict first, then append. Existing records and authentication mappings are never rewritten. */
export function applyNetworkImport(state: DatabaseState, plan: NetworkImportPlan): NetworkImportResult {
  const info = validateSourceInfo(plan.sourceInfo);
  const existingUsers = new Map(state.users.map(user => [user.id, user]));
  const existingUsernames = new Map<string, string[]>();
  for (const user of state.users) {
    const key = usernameKey(user.username);
    if (key) existingUsernames.set(key, [...existingUsernames.get(key) ?? [], user.id]);
    const provenance = (user as Partial<NetworkImportedProfile>).importProvenance;
    if (provenance?.importer === 'pcm-helper' && provenance.sourceHash !== info.sourceHash) fail('SOURCE_CHANGED', 'A previous PCM import has a different source hash; review is required');
  }
  const pending: NetworkImportedProfile[] = [];
  const seenIds = new Set<string>();
  const seenUsernames = new Set<string>();
  let skippedUsers = 0;
  for (const profile of plan.profiles) {
    const provenance = profile.importProvenance;
    if (profile.role !== 'member' || profile.access !== undefined || !provenance || provenance.importer !== 'pcm-helper' || provenance.version !== 1
      || provenance.sourceHash !== info.sourceHash || profile.id !== `pcm-${uid(provenance.nodeUid)}` || profile.joinedAt !== info.importedAt) fail('UNSAFE_IMPORT_PLAN', 'The import plan must contain only member profiles with matching provenance');
    const key = usernameKey(profile.username);
    if (!key || seenIds.has(profile.id) || seenUsernames.has(key)) fail('DUPLICATE_USERNAME', 'Duplicate or missing identity in import plan');
    seenIds.add(profile.id); seenUsernames.add(key);
    const existing = existingUsers.get(profile.id) as NetworkImportedProfile | undefined;
    if (existing && (existing.importProvenance?.importer !== 'pcm-helper' || existing.importProvenance.sourceHash !== info.sourceHash || existing.importProvenance.nodeUid !== provenance.nodeUid)) fail('ID_CONFLICT', `Existing profile ID conflicts with source node ${provenance.sourceId}`);
    if ((existingUsernames.get(key) ?? []).some(id => id !== profile.id)) fail('USERNAME_CONFLICT', `Existing Telegram username conflicts with source node ${provenance.sourceId}`);
    if (existing) { skippedUsers++; continue; }
    pending.push(profile);
  }
  if (!pending.length) return { addedUsers: 0, addedTags: 0, skippedUsers, noop: true };
  const byName = new Map<string, Tag>();
  const byId = new Map(state.tags.map(tag => [tag.id, tag]));
  for (const tag of state.tags) if (!byName.has(tagKey(tag.name))) byName.set(tagKey(tag.name), tag);
  const addedTags: Tag[] = [];
  const canonical = new Map<string, Tag>();
  for (const tag of plan.tags) {
    const name = normalizeImportTagName(tag.name);
    const key = tagKey(name);
    if (!name || name.length > 80 || canonical.has(tag.id)) fail('INVALID_IMPORT_TAG', 'Invalid or duplicate tag in import plan');
    let existing = byName.get(key);
    if (!existing) {
      if (byId.has(tag.id)) fail('TAG_ID_CONFLICT', 'Existing tag ID has a different name');
      existing = { id: tag.id, name }; addedTags.push(existing); byName.set(key, existing); byId.set(existing.id, existing);
    }
    canonical.set(tag.id, existing);
  }
  const addedUsers = pending.map(profile => {
    const copy = structuredClone(profile);
    copy.tags = [...new Set(profile.tags.map(tag => tag.id))].map(id => {
      const tag = canonical.get(id);
      if (!tag) return fail('UNKNOWN_IMPORT_TAG', 'Profile references a tag missing from the import plan');
      return { ...tag };
    });
    return copy;
  });
  state.tags.push(...addedTags);
  state.users.push(...addedUsers);
  return { addedUsers: addedUsers.length, addedTags: addedTags.length, skippedUsers, noop: false };
}
