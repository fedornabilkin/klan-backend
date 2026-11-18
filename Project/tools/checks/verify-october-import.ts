import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { config as loadEnv } from 'dotenv';
import { dirname, resolve } from 'node:path';
import { backendRoot, privateOutputPath } from '../paths.js';
import pg from 'pg';

// Independent audit: no importer/domain functions and no database mutations.
const args: Record<string, string> = {};
const allowed = new Set(['--backup', '--report', '--data-dir', '--source-file', '--output']);
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index], value = process.argv[index + 1];
  if (!allowed.has(key) || !value || value.startsWith('--')) throw new Error(`Unknown or incomplete argument: ${key}`);
  args[key] = value;
}
if (['--backup', '--report', '--data-dir', '--source-file'].some(key => !args[key])) throw new Error('Usage: node --import tsx tools/checks/verify-october-import.ts --backup <pre-apply state.json> --report <applied-report.json> --data-dir <prepared challenge directory> --source-file <reviewed source.xlsx> [--output .local/imports/post-import-verification.json]');
const dir = resolve(backendRoot, args['--data-dir']);
const outputFile = privateOutputPath(args['--output'] ?? '.local/imports/post-import-verification.json');
const read = async (path: string) => JSON.parse(await fs.readFile(path, 'utf8'));
const [source, review, manifest, backup, applied] = await Promise.all([
  read(`${dir}/october-source.json`), read(`${dir}/participant-matches.json`), read(`${dir}/october-import-manifest.json`), read(resolve(backendRoot, args['--backup'])), read(resolve(backendRoot, args['--report'])),
]);
const before = backup.state;
const application = applied.report ?? applied;
if (!before?.users || backup.database !== 'klan_demo' || applied.mode !== 'applied') throw new Error('Expected a klan_demo pre-apply backup and applied report');
loadEnv({ path: resolve(backendRoot, process.env.DOTENV_CONFIG_PATH || '.env'), quiet: true });
const env = process.env;
if (!env.DEMO_DATABASE_URL || new URL(env.DEMO_DATABASE_URL).pathname !== '/klan_demo') throw new Error('Unexpected verification database');
const sourceBytes = await fs.readFile(resolve(backendRoot, args['--source-file']));
const actualSourceHash = createHash('sha256').update(sourceBytes).digest('hex');
const pool = new pg.Pool({ connectionString: env.DEMO_DATABASE_URL, connectionTimeoutMillis: 5000, query_timeout: 20000 });
const connection = await pool.connect();
const current: Record<string, any> = {};
let txReadOnly: string;
try {
  await connection.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  txReadOnly = (await connection.query('SHOW transaction_read_only')).rows[0].transaction_read_only;
  for (const [collection, table] of Object.entries({ users: 'klan_users', entities: 'klan_entities', tags: 'klan_tags', items: 'klan_items' })) {
    current[collection] = (await connection.query(`SELECT data FROM ${table} ORDER BY id`)).rows.map(row => row.data);
  }
  for (const kind of ['telegramUsers', 'userPublicIds']) {
    current[kind] = Object.fromEntries((await connection.query('SELECT id,data FROM klan_auth WHERE kind=$1 ORDER BY id', [kind])).rows.map(row => [row.id, row.data]));
  }
  await connection.query('COMMIT');
} catch (error) { await connection.query('ROLLBACK'); throw error; }
finally { connection.release(); await pool.end(); }

type Check = { name: string; passed: boolean; failures: string[]; expected?: unknown; actual?: unknown };
const checks: Check[] = [];
const check = (name: string, failures: string[], expected?: unknown, actual?: unknown) => checks.push({ name, passed: failures.length === 0, failures, ...(expected !== undefined ? { expected } : {}), ...(actual !== undefined ? { actual } : {}) });
const predicate = (value: boolean, label = 'mismatch') => value ? [] : [label];
const same = (left: unknown, right: unknown) => isDeepStrictEqual(left, right);
const sorted = <T>(rows: T[], key: (row: T) => string) => [...rows].sort((left, right) => key(left).localeCompare(key(right)));
const byId = new Map<string, any>(current.users.map((user: any) => [user.id, user]));
const oldById = new Map<string, any>(before.users.map((user: any) => [user.id, user]));
const manifestById = new Map<string, any>(manifest.participants.map((person: any) => [person.sourceId, person]));
const sourceById = new Map<string, any>(source.participants.map((person: any) => [person.sourceId, person]));
const decisionRows: any[] = application.decisions ?? [];
const decisions = new Map<string, any>(decisionRows.map(person => [person.sourceId, person]));
const newUsers = current.users.filter((person: any) => !oldById.has(person.id));
const newKeys = new Set(manifest.participants.map((person: any) => person.newUser?.key).filter(Boolean));
const existingRows = manifest.participants.filter((person: any) => person.existingUserId);
const newRows = manifest.participants.filter((person: any) => person.newUser);
const expectedUpdated = new Map<string, any>();
for (const person of existingRows) {
  const expected = expectedUpdated.get(person.existingUserId) ?? structuredClone(oldById.get(person.existingUserId));
  if (!expected) throw new Error(`Expected old profile is absent: ${person.sourceId}`);
  if (person.usernameToFill) expected.username = person.usernameToFill;
  if (person.callsignToFill) expected.callsign = person.callsignToFill;
  expectedUpdated.set(person.existingUserId, expected);
}
check('read_only_transaction', predicate(txReadOnly! === 'on'));
check('same_reviewed_source_bytes', predicate([source.sourceSha256, review.sourceSha256, manifest.sourceHash].every(hash => hash === actualSourceHash)));
check('reviewed_population', predicate(source.participants.length === 442 && review.matches.length === 442 && manifest.participants.length === 434), { source: 442, importedSourceRows: 434 }, { source: source.participants.length, importedSourceRows: manifest.participants.length });
check('user_population_and_no_removed_old_profiles', [
  ...before.users.filter((person: any) => !byId.has(person.id)).map((person: any) => person.id),
  ...predicate(current.users.length === before.users.length + newKeys.size && newUsers.length === newKeys.size),
], { before: before.users.length, newUsers: newKeys.size, after: before.users.length + newKeys.size }, { before: before.users.length, newUsers: newUsers.length, after: current.users.length });
check('all_old_profiles_preserved_except_reviewed_empty_contact_fills', before.users.filter((person: any) => !same(expectedUpdated.get(person.id) ?? person, byId.get(person.id))).map((person: any) => person.id));
check('only_empty_username_and_callsign_fields_were_filled', existingRows.flatMap((person: any) => {
  const old = oldById.get(person.existingUserId);
  return [...(person.usernameToFill && old?.username ? [`${person.sourceId}:username`] : []), ...(person.callsignToFill && old?.callsign?.trim() ? [`${person.sourceId}:callsign`] : [])];
}));
check('expected_field_fill_counts', predicate(existingRows.filter((person: any) => person.usernameToFill).length === 177 && existingRows.filter((person: any) => person.callsignToFill).length === 139), { usernames: 177, callsigns: 139 }, { usernames: existingRows.filter((person: any) => person.usernameToFill).length, callsigns: existingRows.filter((person: any) => person.callsignToFill).length });
check('telegram_id_bindings_unchanged', predicate(same(before.telegramUsers, current.telegramUsers)), Object.keys(before.telegramUsers).length, Object.keys(current.telegramUsers).length);
check('new_users_have_no_guessed_telegram_id_binding', newUsers.filter((person: any) => Object.values(current.telegramUsers).includes(person.id)).map((person: any) => person.id));
check('all_old_public_id_fields_preserved', before.users.filter((person: any) => byId.get(person.id)?.publicId !== person.publicId).map((person: any) => person.id));
check('public_ids_unique_and_positive', predicate(new Set(current.users.map((person: any) => person.publicId)).size === current.users.length && current.users.every((person: any) => Number.isSafeInteger(person.publicId) && person.publicId > 0)));
check('public_id_allocation_mapping_retains_existing_keys', Object.entries(before.userPublicIds ?? {}).filter(([key, value]) => key !== 'highWater' && current.userPublicIds[key] !== value).map(([key]) => key));
check('public_id_high_water_advances_only_for_new_profiles', predicate(current.userPublicIds.highWater === Math.max(before.userPublicIds.highWater ?? 0, ...before.users.map((person: any) => person.publicId ?? 0)) + newUsers.length), Math.max(before.userPublicIds.highWater ?? 0, ...before.users.map((person: any) => person.publicId ?? 0)) + newUsers.length, current.userPublicIds.highWater);
check('tags_and_items_unchanged', ['tags', 'items'].filter(field => !same(sorted(before[field], (item: any) => item.id), sorted(current[field], (item: any) => item.id))));
check('old_entities_preserved', before.entities.filter((entity: any) => !same(entity, current.entities.find((item: any) => item.id === entity.id))).map((entity: any) => entity.id));
check('applied_decision_rows_are_complete_and_unique', predicate(decisionRows.length === manifest.participants.length && decisions.size === manifest.participants.length && manifest.participants.every((person: any) => decisions.has(person.sourceId))));
check('existing_identity_decisions_match_reviewed_ids', existingRows.filter((person: any) => decisions.get(person.sourceId)?.userId !== person.existingUserId).map((person: any) => person.sourceId));
check('decision_public_ids_resolve_to_profiles', decisionRows.filter(person => byId.get(person.userId)?.publicId !== person.publicId).map(person => person.sourceId));
const newKeyIds = new Map<string, Set<string>>();
for (const person of newRows) { const ids = newKeyIds.get(person.newUser.key) ?? new Set(); ids.add(decisions.get(person.sourceId)?.userId); newKeyIds.set(person.newUser.key, ids); }
check('duplicate_source_people_create_one_new_profile', [...newKeyIds].filter(([, ids]) => ids.size !== 1).map(([key]) => key));
check('new_profile_population_equals_reviewed_new_keys', predicate(new Set([...newKeyIds.values()].flatMap(ids => [...ids])).size === newUsers.length));
check('new_profiles_contain_only_source_identity_and_empty_unknown_fields', newRows.flatMap((person: any) => {
  const user = byId.get(decisions.get(person.sourceId)?.userId);
  if (!user || oldById.has(user.id)) return [`${person.sourceId}:not_new`];
  const good = user.name === person.newUser.name && (user.callsign ?? '') === person.newUser.callsign && (user.username ?? '') === (person.newUser.username ?? '') && user.role === 'member' && user.bio === '' && same(user.location, { city: '', country: '', lat: null, lng: null }) && ['tags', 'facts', 'interests', 'achievements'].every(field => Array.isArray(user[field]) && user[field].length === 0) && !user.birthDate && !user.firstName && !user.middleName && !user.lastName && same(user.stats, { events: 0, challenges: 0, books: 0 });
  return good ? [] : [person.sourceId];
}));
const newEntities = current.entities.filter((entity: any) => !before.entities.some((old: any) => old.id === entity.id));
const teams = newEntities.filter((entity: any) => entity.type === 'teams');
const challenge = newEntities.find((entity: any) => entity.id === application.challengeId);
check('exactly_23_teams_and_one_challenge_added', predicate(newEntities.length === 24 && teams.length === 23 && newEntities.filter((entity: any) => entity.type === 'challenges').length === 1), 24, newEntities.length);
if (!challenge) throw new Error('Imported challenge missing');
check('challenge_identity_goal_period_and_completion', predicate(challenge.type === 'challenges' && challenge.title === manifest.title && challenge.status === 'completed' && challenge.category === 'count' && challenge.goal.target === 421841 && challenge.goal.target === manifest.target && challenge.goal.unit === manifest.unit && challenge.schedule.start.slice(0, 10) === manifest.startDate && challenge.schedule.end.slice(0, 10) === manifest.endDate));
const teamByKey = new Map<string, any>(manifest.teams.map((team: any) => [team.key, teams.find((entity: any) => entity.title === team.title)]));
check('team_names_targets_and_active_status', manifest.teams.filter((team: any) => { const current = teamByKey.get(team.key); return !current || current.status !== 'active' || current.goal?.target !== team.target || current.goal?.unit !== manifest.unit; }).map((team: any) => team.key));
const expectedMembers = new Map<string, any>();
const expectedResults = new Map<string, any>();
const expectedPending = new Map<string, any>();
const sourceResultMismatches: string[] = [];
let sourceDuplicateResults = 0;
for (const person of manifest.participants) {
  const decision = decisions.get(person.sourceId), team = teamByKey.get(person.teamKey), raw = sourceById.get(person.sourceId);
  if (!decision || !team || !raw) throw new Error('Manifest mapping is incomplete');
  if (decision.teamId !== team.id) sourceResultMismatches.push(`${person.sourceId}:team`);
  const expected = { userId: decision.userId, teamId: team.id, title: team.title, ...(person.target !== undefined ? { target: person.target } : {}) };
  if (expectedMembers.has(decision.userId) && !same(expectedMembers.get(decision.userId), expected)) sourceResultMismatches.push(`${person.sourceId}:duplicate_membership`);
  expectedMembers.set(decision.userId, expected);
  if (!same(person.results, raw.results.map(({ date, value, sourceCell }: any) => ({ date, value, sourceCell })))) sourceResultMismatches.push(`${person.sourceId}:dated_source`);
  if (!same(person.pendingResults.map(({ value, sourceCell }: any) => ({ value, sourceCell })), raw.undatedResults.map(({ value, sourceCell }: any) => ({ value, sourceCell })))) sourceResultMismatches.push(`${person.sourceId}:pending_source`);
  for (const result of person.results) {
    const key = `${decision.userId}:${result.date}`;
    const value = { userId: decision.userId, date: result.date, value: result.value, teamId: team.id, title: team.title };
    if (expectedResults.has(key)) { sourceDuplicateResults++; if (!same(expectedResults.get(key), value)) sourceResultMismatches.push(`${person.sourceId}:conflicting_duplicate`); }
    expectedResults.set(key, value);
  }
  for (const result of person.pendingResults) {
    if (expectedPending.has(result.sourceCell)) sourceResultMismatches.push(`${person.sourceId}:repeated_pending_cell`);
    expectedPending.set(result.sourceCell, { userId: decision.userId, teamId: team.id, title: team.title, value: result.value, sourceCell: result.sourceCell, reason: result.reason });
  }
}
check('manifest_records_match_original_extraction', sourceResultMismatches);
const actualMembers = challenge.participants.map((person: any) => ({ userId: person.user.id, teamId: person.team?.id, title: person.team?.title, ...(person.target !== undefined ? { target: person.target } : {}) }));
check('challenge_participants_and_plans_match_unique_source_people', predicate(same(sorted([...expectedMembers.values()], person => person.userId), sorted(actualMembers, (person: any) => person.userId))), expectedMembers.size, actualMembers.length);
check('all_team_memberships_match_reviewed_source', [...teamByKey].flatMap(([key, team]) => {
  const expected = [...expectedMembers.values()].filter(person => person.teamId === team.id).map(person => person.userId).sort();
  const actual = team.participants.map((person: any) => person.user.id).sort();
  return same(expected, actual) ? [] : [key];
}));
const memberships = current.entities.filter((entity: any) => entity.type === 'teams' && entity.status === 'active').flatMap((team: any) => team.participants.map((person: any) => person.user.id));
check('one_active_team_per_participant', predicate(new Set(memberships).size === memberships.length));
const actualResults = (challenge.results ?? []).map((result: any) => ({ userId: result.user.id, date: result.date, value: result.value, teamId: result.team?.id, title: result.team?.title }));
check('every_dated_record_equals_source_user_date_quantity_team', predicate(same(sorted([...expectedResults.values()], result => `${result.userId}:${result.date}`), sorted(actualResults, (result: any) => `${result.userId}:${result.date}`))), expectedResults.size, actualResults.length);
const actualPending = (challenge.pendingResults ?? []).map((result: any) => ({ userId: result.user.id, value: result.value, teamId: result.team?.id, title: result.team?.title, sourceCell: result.sourceCell, reason: result.reason }));
check('every_undated_record_preserves_source_quantity_cell_and_person', predicate(same(sorted([...expectedPending.values()], result => result.sourceCell), sorted(actualPending, (result: any) => result.sourceCell))), expectedPending.size, actualPending.length);
check('pending_dates_are_not_fabricated', (challenge.pendingResults ?? []).filter((result: any) => 'date' in result).map((result: any) => result.sourceCell));
check('dated_records_are_unique_calendar_days_inside_period', actualResults.filter((result: any) => !/^\d{4}-\d{2}-\d{2}$/.test(result.date) || new Date(`${result.date}T00:00:00Z`).toISOString().slice(0, 10) !== result.date || result.date < manifest.startDate || result.date > manifest.endDate || !Number.isSafeInteger(result.value) || result.value < 0).map((result: any) => `${result.userId}:${result.date}`));
check('no_duplicate_dated_records', predicate(new Set(actualResults.map((result: any) => `${result.userId}:${result.date}`)).size === actualResults.length));
const sum = (rows: any[]) => rows.reduce((total, row) => total + row.value, 0);
const actualTotal = sum(actualResults), pendingTotal = sum(actualPending), actualZeros = actualResults.filter((row: any) => row.value === 0).length;
check('dated_and_pending_totals_reconcile_independently', predicate(actualTotal === sum([...expectedResults.values()]) && pendingTotal === sum([...expectedPending.values()]) && actualTotal === 326327 && pendingTotal === 29174), { dated: 326327, pending: 29174 }, { dated: actualTotal, pending: pendingTotal });
check('explicit_zeros_preserved_without_invented_blanks', predicate(actualZeros === [...expectedResults.values()].filter(row => row.value === 0).length), [...expectedResults.values()].filter(row => row.value === 0).length, actualZeros);
const excluded = review.matches.filter((row: any) => row.status === 'ambiguous');
check('eight_ambiguous_identity_rows_held_back', predicate(excluded.length === 8 && excluded.every((row: any) => !manifestById.has(row.sourceId) && !decisions.has(row.sourceId))));
const heldTotal = excluded.reduce((total: number, row: any) => total + sum(sourceById.get(row.sourceId).results), 0);
check('all_source_dated_quantities_accounted_for_in_import_or_hold', predicate(actualTotal + heldTotal === source.summary.datedResultSum), source.summary.datedResultSum, actualTotal + heldTotal);
check('all_source_pending_quantities_accounted_for', predicate(pendingTotal === source.summary.undatedResultSum && actualPending.length === source.summary.undatedResultCount), { count: source.summary.undatedResultCount, total: source.summary.undatedResultSum }, { count: actualPending.length, total: pendingTotal });
check('applied_summary_matches_actual_database', predicate(application.usersCreated === newUsers.length && application.teamsCreated === teams.length && application.participants === actualMembers.length && application.resultsCreated === actualResults.length && application.resultTotal === actualTotal && application.pendingResultsCreated === actualPending.length && application.pendingTotal === pendingTotal && application.resultsDeduplicated === sourceDuplicateResults));
const teamSummaries = teams.map((team: any) => {
  const rows = actualResults.filter((result: any) => result.teamId === team.id), pending = actualPending.filter((result: any) => result.teamId === team.id);
  return { id: team.id, title: team.title, members: team.participants.length, target: team.goal.target, resultCount: rows.length, resultTotal: sum(rows), pendingCount: pending.length, pendingTotal: sum(pending) };
});
check('team_report_totals_match_actual_records', predicate(same(sorted(teamSummaries, (team: any) => team.id), sorted(application.teams, (team: any) => team.id))));
const output = { verifiedAt: new Date().toISOString(), database: 'klan_demo', readOnly: true, sourceHash: actualSourceHash, backupFile: args['--backup'], appliedReportFile: args['--report'], summary: { checks: checks.length, passed: checks.filter(check => check.passed).length, failed: checks.filter(check => !check.passed).length, users: current.users.length, newUsers: newUsers.length, teams: teams.length, participants: actualMembers.length, datedRecords: actualResults.length, datedTotal: actualTotal, explicitZeros: actualZeros, sourceDuplicateResults, pendingRecords: actualPending.length, pendingTotal, heldIdentityRows: excluded.length, heldDatedTotal: heldTotal, telegramBindings: Object.keys(current.telegramUsers).length }, checks, teams: teamSummaries };
await fs.mkdir(dirname(outputFile), { recursive: true });
await fs.writeFile(outputFile, JSON.stringify(output, null, 2));
console.log(JSON.stringify(output.summary, null, 2));
for (const failed of checks.filter(check => !check.passed)) console.error(`${failed.name}: ${failed.failures.slice(0, 20).join(', ')}`);
if (output.summary.failed) process.exitCode = 1;
