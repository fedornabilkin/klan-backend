import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Entity, User } from '../../src/shared/contracts.js';
import { isCalendarDate } from '../../src/shared/profile-entries.js';
import { normalizeTelegramUsername } from '../../src/shared/profile-identity.js';
import type { DatabaseState } from '../../src/repository.js';
import { allocateUserPublicId } from '../../src/user-ids.js';

const text = z.string().trim().min(1).max(120);
const key = z.string().trim().min(1).max(200);
const count = z.number().int().nonnegative().max(10_000_000);
const date = z.string().refine(isCalendarDate, 'Expected a real calendar date YYYY-MM-DD');
const username = z.string().transform(normalizeTelegramUsername).refine(value => /^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(value), 'Invalid Telegram username');
const sourceCell = z.string().regex(/^[A-Z]{1,3}[1-9][0-9]{0,6}$/);
const participantSchema = z.object({
  sourceId: key, sourceRow: z.number().int().positive(), teamKey: key,
  existingUserId: key.optional(),
  newUser: z.object({ key, name: text, callsign: z.string().trim().max(120), username: username.optional() }).strict().optional(),
  expectedUser: z.object({ name: text, username: z.string().optional() }).strict().optional(),
  usernameToFill: username.optional(), callsignToFill: text.optional(), target: count.optional(),
  results: z.array(z.object({ date, value: count, sourceCell }).strict()),
  pendingResults: z.array(z.object({ value: count, sourceCell, reason: z.string().trim().min(1).max(1000) }).strict()),
}).strict().superRefine((participant, context) => {
  if (Boolean(participant.existingUserId) === Boolean(participant.newUser)) context.addIssue({ code: 'custom', message: 'Specify exactly one existingUserId or newUser' });
  if (participant.newUser && (participant.expectedUser || participant.usernameToFill || participant.callsignToFill)) context.addIssue({ code: 'custom', message: 'New profiles use only newUser identity fields' });
});
export const historicalChallengeManifestSchema = z.object({
  key, sourceHash: z.string().regex(/^[a-f0-9]{64}$/), title: text,
  description: z.string().trim().max(5000), startDate: date, endDate: date,
  target: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), unit: text,
  teams: z.array(z.object({ key, title: text, target: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict()).min(1),
  participants: z.array(participantSchema).min(1),
}).strict();
export type HistoricalChallengeManifest = z.infer<typeof historicalChallengeManifestSchema>;
export class HistoricalChallengeImportError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = 'HistoricalChallengeImportError'; }
}
export interface HistoricalChallengeImportReport {
  alreadyImported: boolean; changed: boolean; challengeId: string;
  teamsCreated: number; usersCreated: number; usersUpdated: number; usernamesFilled: number; callsignsFilled: number;
  sourceRows: number; participants: number; duplicateRowsMerged: number;
  resultsCreated: number; resultsDeduplicated: number; pendingResultsCreated: number;
  resultTotal: number; pendingTotal: number;
  teams: { id: string; title: string; members: number; target: number; resultCount: number; resultTotal: number; pendingCount: number; pendingTotal: number }[];
  decisions: { sourceId: string; sourceRow: number; userId: string; publicId?: number; teamId: string; created: boolean }[];
}
interface ImportMetadata {
  key: string; sourceHash: string; manifestHash: string; importedAt: string;
  report?: HistoricalChallengeImportReport;
}
type ImportedEntity = Entity & { historicalImport?: ImportMetadata };

const reject = (code: string, message: string): never => { throw new HistoricalChallengeImportError(code, message); };
const nameKey = (value: string) => value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('ru').replace(/ё/gu, 'е');
const handleKey = (value?: string) => value ? normalizeTelegramUsername(value).toLowerCase() : '';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
  return JSON.stringify(value);
}
export function historicalChallengeId(importKey: string): string { return `history-challenge-${hash(importKey).slice(0, 24)}`; }
export function historicalTeamId(importKey: string, teamKey: string): string { return `history-team-${hash(`${importKey}\u0000${teamKey}`).slice(0, 24)}`; }

/** Stored references stay compact. hydrateEntity resolves their current canonical profiles. */
function reference(user: User): User {
  return {
    id: user.id, name: user.name, role: user.role, initials: user.initials, color: user.color, joinedAt: user.joinedAt,
    ...(user.publicId ? { publicId: user.publicId } : {}), ...(user.username ? { username: user.username } : {}), ...(user.callsign ? { callsign: user.callsign } : {}),
    bio: '', location: { city: '', country: '', lat: null, lng: null }, tags: [], facts: [], interests: [], achievements: [], stats: { events: 0, challenges: 0, books: 0 },
  };
}

/** A pure preview; only a caller's serialized repository write may publish plan.state. */
export function planHistoricalChallengeImport(original: DatabaseState, input: unknown, options: { importedAt: string }): { state: DatabaseState; report: HistoricalChallengeImportReport } {
  const parsed = historicalChallengeManifestSchema.safeParse(input);
  if (!parsed.success) reject('INVALID_MANIFEST', parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; '));
  const manifest = parsed.data!;
  const importedAt = new Date(options.importedAt);
  if (!Number.isFinite(importedAt.getTime()) || importedAt.toISOString() !== options.importedAt) reject('INVALID_IMPORT_TIME', 'importedAt must be a canonical ISO timestamp');
  if (manifest.startDate > manifest.endDate || manifest.endDate >= options.importedAt.slice(0, 10)) reject('INVALID_PERIOD', 'Historical import requires a completed calendar period');
  const manifestHash = hash(stableJson(manifest));
  const challengeId = historicalChallengeId(manifest.key);
  const previous = original.entities.find(entity => entity.type === 'challenges' && (entity as ImportedEntity).historicalImport?.key === manifest.key) as ImportedEntity | undefined;
  if (previous) {
    if (previous.id !== challengeId || previous.historicalImport?.sourceHash !== manifest.sourceHash || previous.historicalImport.manifestHash !== manifestHash) reject('SOURCE_CHANGED', 'This challenge was already imported with a different source or reviewed manifest; an explicit correction plan is required');
    const saved = previous.historicalImport?.report;
    if (!saved) reject('INCOMPLETE_IMPORT_METADATA', 'The existing import has no reconciliation report');
    return { state: structuredClone(original), report: { ...structuredClone(saved!), changed: false, alreadyImported: true, teamsCreated: 0, usersCreated: 0, usersUpdated: 0, usernamesFilled: 0, callsignsFilled: 0, resultsCreated: 0, pendingResultsCreated: 0 } };
  }
  if (original.entities.some(entity => entity.id === challengeId || entity.type === 'challenges' && nameKey(entity.title) === nameKey(manifest.title))) reject('CHALLENGE_EXISTS', 'A challenge with this identity or title already exists; review it before importing');
  const teamKeys = new Set<string>(), teamTitles = new Set<string>(), sourceIds = new Set<string>(), sourceCells = new Set<string>();
  for (const team of manifest.teams) {
    if (teamKeys.has(team.key) || teamTitles.has(nameKey(team.title))) reject('DUPLICATE_TEAM', `Repeated team key or title: ${team.title}`);
    teamKeys.add(team.key); teamTitles.add(nameKey(team.title));
    if (original.entities.some(entity => entity.id === historicalTeamId(manifest.key, team.key) || entity.type === 'teams' && nameKey(entity.title) === nameKey(team.title))) reject('TEAM_EXISTS', `Team already exists: ${team.title}`);
  }
  for (const participant of manifest.participants) {
    if (sourceIds.has(participant.sourceId)) reject('DUPLICATE_SOURCE_ROW', `Repeated source identity: ${participant.sourceId}`);
    sourceIds.add(participant.sourceId);
    if (!teamKeys.has(participant.teamKey)) reject('UNKNOWN_TEAM', `Unknown team for ${participant.sourceId}`);
    for (const result of participant.results) if (result.date < manifest.startDate || result.date > manifest.endDate) reject('RESULT_OUTSIDE_PERIOD', `Result ${result.sourceCell} is outside the challenge dates`);
    for (const result of [...participant.results, ...participant.pendingResults]) {
      if (sourceCells.has(result.sourceCell)) reject('DUPLICATE_SOURCE_CELL', `Source cell ${result.sourceCell} was assigned more than once`);
      sourceCells.add(result.sourceCell);
    }
  }
  const state = structuredClone(original);
  const report: HistoricalChallengeImportReport = {
    alreadyImported: false, changed: true, challengeId, teamsCreated: manifest.teams.length,
    usersCreated: 0, usersUpdated: 0, usernamesFilled: 0, callsignsFilled: 0, sourceRows: manifest.participants.length,
    participants: 0, duplicateRowsMerged: 0, resultsCreated: 0, resultsDeduplicated: 0, pendingResultsCreated: 0,
    resultTotal: 0, pendingTotal: 0, teams: [], decisions: [],
  };
  const metadata = { key: manifest.key, sourceHash: manifest.sourceHash, manifestHash, importedAt: options.importedAt };
  const sport = state.tags.find(tag => nameKey(tag.name) === 'спорт');
  const tags = sport ? [structuredClone(sport)] : [];
  const challenge: ImportedEntity = {
    id: challengeId, type: 'challenges', title: manifest.title, description: manifest.description,
    status: 'completed', category: 'count', tags, createdAt: options.importedAt,
    schedule: { start: `${manifest.startDate}T00:00:00.000+03:00`, end: `${manifest.endDate}T23:59:59.999+03:00` },
    goal: { target: manifest.target, unit: manifest.unit }, participants: [], results: [], pendingResults: [], historicalImport: metadata,
  };
  const teams = new Map(manifest.teams.map(team => {
    const entity: ImportedEntity = {
      id: historicalTeamId(manifest.key, team.key), type: 'teams', title: team.title,
      description: `Команда участников челленджа «${manifest.title}».`, status: 'active', category: '', tags,
      createdAt: options.importedAt, participants: [], goal: { target: team.target, unit: manifest.unit },
      historicalImport: { ...metadata, key: `${manifest.key}:team:${team.key}` },
    };
    return [team.key, entity] as const;
  }));
  const resolved = new Map<string, User>(), createdProfiles = new Map<string, { signature: string; user: User }>(), changedUsers = new Set<string>();
  const usernames = new Map<string, string[]>();
  for (const user of state.users) if (user.username) usernames.set(handleKey(user.username), [...(usernames.get(handleKey(user.username)) ?? []), user.id]);
  const assertUsernameAvailable = (value: string, userId: string) => {
    if ((usernames.get(handleKey(value)) ?? []).some(id => id !== userId)) reject('USERNAME_CONFLICT', `Telegram username ${value} belongs to another profile`);
  };
  // Resolve all identities before taking any embedded snapshots, so rows for the
  // same person share the final reviewed contact data regardless of row order.
  for (const row of manifest.participants) {
    let user: User;
    let created = false;
    if (row.existingUserId) {
      const current = state.users.find(candidate => candidate.id === row.existingUserId);
      const prior = original.users.find(candidate => candidate.id === row.existingUserId);
      if (!current || !prior) reject('USER_NOT_FOUND', `Missing reviewed profile for ${row.sourceId}`);
      user = current!;
      if (row.expectedUser && (prior!.name !== row.expectedUser.name || handleKey(prior!.username) !== handleKey(row.expectedUser.username))) reject('STALE_IDENTITY_REVIEW', `Profile changed after matching: ${row.sourceId}`);
      if (row.usernameToFill) {
        assertUsernameAvailable(row.usernameToFill, user.id);
        if (user.username && handleKey(user.username) !== handleKey(row.usernameToFill)) reject('USERNAME_NOT_EMPTY', `Cannot replace existing username for ${row.sourceId}`);
        if (!user.username) { user.username = row.usernameToFill; usernames.set(handleKey(user.username), [user.id]); report.usernamesFilled++; changedUsers.add(user.id); }
      }
      if (row.callsignToFill) {
        if (user.callsign?.trim() && user.callsign.trim() !== row.callsignToFill) reject('CALLSIGN_NOT_EMPTY', `Cannot replace existing callsign for ${row.sourceId}`);
        if (!user.callsign?.trim()) { user.callsign = row.callsignToFill; report.callsignsFilled++; changedUsers.add(user.id); }
      }
    } else {
      const incoming = row.newUser!;
      const signature = stableJson(incoming);
      const existing = createdProfiles.get(incoming.key);
      if (existing) {
        if (existing.signature !== signature) reject('NEW_IDENTITY_CONFLICT', `Different identities use new profile key ${incoming.key}`);
        user = existing.user;
      } else {
        const id = `history-user-${hash(`${manifest.key}\u0000${incoming.key}`).slice(0, 24)}`;
        if (state.users.some(candidate => candidate.id === id)) reject('USER_ID_CONFLICT', `Stable profile ID already exists for ${incoming.key}`);
        if (incoming.username) assertUsernameAvailable(incoming.username, id);
        user = {
          id, publicId: allocateUserPublicId(state), name: incoming.name, callsign: incoming.callsign,
          ...(incoming.username ? { username: incoming.username } : {}), role: 'member', bio: '',
          location: { city: '', country: '', lat: null, lng: null }, tags: [], facts: [], interests: [], achievements: [],
          initials: incoming.name.split(/\s+/).slice(0, 2).map(part => part[0]).join('').toUpperCase(), color: '#9b6e40',
          stats: { events: 0, challenges: 0, books: 0 }, joinedAt: options.importedAt,
        };
        state.users.push(user); createdProfiles.set(incoming.key, { signature, user }); report.usersCreated++;
        if (user.username) usernames.set(handleKey(user.username), [user.id]);
      }
      created = true;
    }
    resolved.set(row.sourceId, user);
    report.decisions.push({ sourceId: row.sourceId, sourceRow: row.sourceRow, userId: user.id, ...(user.publicId ? { publicId: user.publicId } : {}), teamId: teams.get(row.teamKey)!.id, created });
  }
  report.usersUpdated = changedUsers.size;
  const memberships = new Map<string, string>(), results = new Map<string, number>(), pendingCells = new Set<string>();
  for (const row of manifest.participants) {
    const user = resolved.get(row.sourceId)!;
    const team = teams.get(row.teamKey)!;
    const teamRef = { id: team.id, title: team.title };
    const previousTeam = memberships.get(user.id);
    if (previousTeam && previousTeam !== team.id) reject('MULTIPLE_ACTIVE_TEAMS', `Reviewed user ${user.id} occurs in different teams`);
    const activeTeam = original.entities.find(entity => entity.type === 'teams' && entity.status === 'active' && entity.participants.some(participant => participant.user.id === user.id));
    if (activeTeam) reject('ACTIVE_TEAM_CONFLICT', `User ${user.id} already belongs to active team ${activeTeam.title}`);
    if (!previousTeam) {
      memberships.set(user.id, team.id);
      team.participants.push({ user: reference(user) });
      challenge.participants.push({ user: reference(user), team: teamRef, ...(row.target !== undefined ? { target: row.target } : {}) });
    } else {
      report.duplicateRowsMerged++;
      const participation = challenge.participants.find(participant => participant.user.id === user.id)!;
      if (row.target !== undefined && participation.target !== undefined && row.target !== participation.target) reject('PARTICIPANT_TARGET_CONFLICT', `Different plans for repeated user ${user.id}`);
      if (participation.target === undefined && row.target !== undefined) participation.target = row.target;
    }
    for (const entry of row.results) {
      const resultKey = `${user.id}\u0000${entry.date}`;
      if (results.has(resultKey)) {
        if (results.get(resultKey) !== entry.value) reject('RESULT_CONFLICT', `Different quantities for ${user.id} on ${entry.date}`);
        report.resultsDeduplicated++;
        continue;
      }
      results.set(resultKey, entry.value);
      challenge.results!.push({ user: reference(user), team: teamRef, date: entry.date, value: entry.value });
      report.resultTotal += entry.value;
    }
    for (const entry of row.pendingResults) {
      const pendingKey = entry.sourceCell;
      if (pendingCells.has(pendingKey)) reject('DUPLICATE_PENDING_CELL', `Undated source cell is repeated: ${entry.sourceCell}`);
      pendingCells.add(pendingKey);
      challenge.pendingResults!.push({ user: reference(user), team: teamRef, ...entry });
      report.pendingTotal += entry.value;
    }
  }
  report.participants = challenge.participants.length;
  report.resultsCreated = challenge.results!.length;
  report.pendingResultsCreated = challenge.pendingResults!.length;
  challenge.results!.sort((left, right) => left.date.localeCompare(right.date) || left.user.id.localeCompare(right.user.id));
  for (const team of teams.values()) {
    const actual = challenge.results!.filter(result => result.team?.id === team.id), pending = challenge.pendingResults!.filter(result => result.team?.id === team.id);
    report.teams.push({ id: team.id, title: team.title, members: team.participants.length, target: team.goal!.target, resultCount: actual.length, resultTotal: actual.reduce((sum, result) => sum + result.value, 0), pendingCount: pending.length, pendingTotal: pending.reduce((sum, result) => sum + result.value, 0) });
  }
  challenge.historicalImport = { ...metadata, report: structuredClone(report) };
  state.entities.push(...teams.values(), challenge);
  return { state, report };
}
