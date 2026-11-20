import { z } from 'zod';
import type { DatabaseState, Repository } from '../../src/repository.js';
import type { User } from '../../src/shared/contracts.js';
import { allocateUserPublicId } from '../../src/user-ids.js';
import type { HistoricalChallengeImportReport } from './challenge-import.js';

const label = z.string().trim().min(1).max(120);
export const memberPlan = z.object({
  version: z.literal(1), sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
  members: z.array(z.object({
    sourceId: z.string().regex(/^\d+$/), nodeUid: z.uuid(), firstName: label, lastName: label, callsign: label.optional(),
  }).strict()).min(1).max(1000),
  correction: z.object({ publicId: z.number().int().positive(), id: label, firstName: label, oldLastName: label, newLastName: label }).strict(),
  profileNumbers: z.object({ firstId: label, secondId: label, formerSecondId: label }).strict().optional(),
}).strict();
type Plan = z.infer<typeof memberPlan>;
type Imported = User & { importProvenance?: { importer: string; nodeUid?: string; sourceHash?: string } };

const key = (text: string) => text.normalize('NFKC').trim().toLowerCase().replaceAll('ё', 'е').replace(/\s+/gu, ' ');
function sameName(user: User, first: string, last: string) {
  if (key(user.firstName ?? '') === key(first) && key(user.lastName ?? '') === key(last)) return true;
  const words = key(user.name.replace(/\[[^\]]*\]|«[^»]*»|\([^)]*\)/gu, '')).split(' ');
  return words.includes(key(first)) && words.includes(key(last));
}

function reassignNumbers(state: DatabaseState, users: User[], spec: NonNullable<Plan['profileNumbers']>, apply: boolean) {
  const first = users.find(u => u.id === spec.firstId);
  const second = users.find(u => u.id === spec.secondId);
  const displaced = users.find(u => u.id === spec.formerSecondId);
  if (!first || !second || !displaced || new Set([first.id, second.id, displaced.id]).size !== 3) {
    throw new Error('Три подтверждённых профиля для переноса номеров не найдены.');
  }
  const complete = first.publicId === 1 && second.publicId === 2 && (displaced.publicId ?? 0) > 2;
  if (!complete && (second.publicId !== 1 || displaced.publicId !== 2)) {
    throw new Error('Владельцы номеров 1 и 2 изменились. Перенос отменён.');
  }
  // Reserve the next number before the repository numbers newly imported members.
  const next = complete ? displaced.publicId! : allocateUserPublicId({ ...state, users, userPublicIds: { ...state.userPublicIds } });
  const moves = [
    { user: displaced, to: next }, { user: second, to: 2 }, { user: first, to: 1 },
  ];
  const byId = new Map(moves.map(({ user, to }) => [user.id, to]));
  const byOldNumber = new Map<number, number>();
  const profiles = moves.map(({ user, to }) => {
    if (users.some(u => u.id === String(to) && u.id !== user.id) ||
        (user.publicId !== undefined && users.some(u => u.id === String(user.publicId) && u.id !== user.id))) {
      throw new Error('Числовой внутренний ID совпадает с переносимым публичным номером.');
    }
    if (user.publicId !== undefined && user.publicId !== to) byOldNumber.set(user.publicId, to);
    return { name: user.name, from: user.publicId ?? null, to };
  });

  let snapshots = 0, links = 0;
  function sync(ref: { publicId?: number } | undefined, id: string | undefined) {
    const number = id && byId.get(id);
    if (ref && number && ref.publicId !== number) {
      snapshots++;
      if (apply) ref.publicId = number;
    }
  }
  function person(ref?: Pick<User, 'id' | 'publicId'>) { sync(ref, ref?.id); }
  for (const entity of state.entities) {
    person(entity.author);
    person(entity.organizerUser);
    entity.readers?.forEach(person);
    for (const group of [entity.participants, entity.results ?? [], entity.pendingResults ?? []]) {
      for (const row of group) person(row.user);
    }
    const history = (entity as { historicalImport?: { report?: HistoricalChallengeImportReport } }).historicalImport;
    for (const decision of history?.report?.decisions ?? []) sync(decision, decision.userId);
  }
  for (const activity of state.activities) {
    person(activity.actor);
    const target = activity.target;
    if (!target) continue;
    person(target.user);
    const match = /^\/users\/([1-9]\d*)(\/?(?:[?#].*)?)$/.exec(target.path);
    if (!match) continue;
    const old = Number(match[1]);
    const to = byOldNumber.get(old);
    if (to === undefined) continue;
    if (target.user && byId.get(target.user.id) !== to) throw new Error('Номер в ссылке истории противоречит сохранённому участнику.');
    links++;
    if (apply) target.path = '/users/' + to + match[2];
  }
  if (apply && !complete) {
    // PostgreSQL enforces the publicId index on each upsert. Vacate 2, then 1, before reusing either.
    for (const { user, to } of moves) user.publicId = to;
    state.users = [...moves.map(m => m.user), ...users.filter(u => !byId.has(u.id))];
  }
  return { profiles: profiles.reverse(), snapshots, links };
}

function reconcile(state: DatabaseState, plan: Plan, apply: boolean, correctionOnly: boolean, now: string) {
  const edit = plan.correction;
  const target = state.users.find(user => user.publicId === edit.publicId);
  if (!target || target.id !== edit.id) throw new Error('Публичный и внутренний ID исправляемого профиля не совпали с планом.');
  const fullName = (last: string) => [edit.firstName, target.middleName, last].filter(Boolean).join(' ');
  const allowed = [edit.oldLastName, edit.newLastName];
  if (!allowed.some(last => key(target.name) === key(fullName(last))) ||
      (target.firstName && key(target.firstName) !== key(edit.firstName)) ||
      (target.lastName && !allowed.some(last => key(target.lastName!) === key(last)))) {
    throw new Error('Имя исправляемого профиля изменилось. Проверьте его перед повторным запуском.');
  }
  if (state.users.some(u => u.id !== target.id && sameName(u, edit.firstName, edit.newLastName))) {
    throw new Error('Исправленное имя уже есть у другого участника.');
  }
  const correctedName = fullName(edit.newLastName);
  const rename = target.name !== correctedName || target.firstName !== edit.firstName || target.lastName !== edit.newLastName;
  const added: User[] = [];
  const known: string[] = [];
  const review: { name: string; profileIds: (number | undefined)[] }[] = [];
  const users: Imported[] = state.users;
  const members = correctionOnly ? [] : plan.members;
  for (const values of [members.map(m => m.nodeUid), members.map(m => m.sourceId), members.map(m => key(m.firstName + ' ' + m.lastName))]) {
    if (new Set(values).size !== values.length) throw new Error('В списке повторяется участник.');
  }
  for (const m of members) {
    const id = 'member-' + m.nodeUid, name = m.firstName + ' ' + m.lastName;
    if (name.length > 120) throw new Error('Слишком длинное имя в плане.');
    if (key(m.firstName) === key(edit.firstName) && allowed.some(last => key(last) === key(m.lastName))) {
      throw new Error('Исправляемый профиль повторно указан среди новых участников.');
    }
    const stable = users.filter(u => u.id === id || u.id === 'pcm-' + m.nodeUid || u.importProvenance?.nodeUid === m.nodeUid);
    if (stable.length) {
      const origin = stable[0]!.importProvenance;
      if (stable.length !== 1 || !origin || origin.nodeUid !== m.nodeUid || origin.sourceHash !== plan.sourceHash ||
          !['klan-network','pcm-helper'].includes(origin.importer)) {
        throw new Error('Конфликт идентификатора исходной записи: ' + name);
      }
      known.push(name);
      continue;
    }
    const matches = users.filter(u => sameName(u, m.firstName, m.lastName));
    if (matches.length) {
      review.push({ name, profileIds: matches.map(u => u.publicId) });
      continue;
    }
    const profile = {
      id, name, firstName: m.firstName, lastName: m.lastName, ...(m.callsign && { callsign: m.callsign }),
      initials: (m.firstName[0]! + m.lastName[0]!).toUpperCase(), color: '#b57439', role: 'member' as const,
      joinedAt: now, bio: '', location: { city: '', country: '', lat: null, lng: null },
      tags: [], facts: [], interests: [], achievements: [], stats: { events: 0, challenges: 0, books: 0 },
      importProvenance: { importer: 'klan-network', version: 1, sourceHash: plan.sourceHash, sourceId: m.sourceId, nodeUid: m.nodeUid, importedAt: now },
    };
    added.push(profile);
  }
  if (apply) {
    if (rename) Object.assign(target, { name: correctedName, firstName: edit.firstName, lastName: edit.newLastName });
    state.users.push(...added);
  }
  const numbers = !correctionOnly && plan.profileNumbers
    ? reassignNumbers(state, apply ? state.users : [...users, ...added], plan.profileNumbers, apply) : undefined;
  return { added: added.map(u => ({ name: u.name, callsign: u.callsign })), known, review, rename, correctedName, publicId: edit.publicId, numbers };
}

export async function importReviewedMembers(repo: Repository, input: unknown, apply = false, correctionOnly = false) {
  const plan = memberPlan.parse(input);
  const run = (state: DatabaseState) => reconcile(state, plan, apply, correctionOnly, new Date().toISOString());
  return apply ? repo.write(run) : repo.read(run);
}
