import { z } from 'zod';
import type { DatabaseState, Repository } from '../../src/repository.js';
import type { User } from '../../src/shared/contracts.js';

const label = z.string().trim().min(1).max(120);
export const memberPlan = z.object({
  version: z.literal(1), sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
  members: z.array(z.object({
    sourceId: z.string().regex(/^\d+$/), nodeUid: z.uuid(), firstName: label, lastName: label, callsign: label.optional(),
  }).strict()).min(1).max(1000),
  correction: z.object({ publicId: z.number().int().positive(), id: label, firstName: label, oldLastName: label, newLastName: label }).strict(),
}).strict();
type Plan = z.infer<typeof memberPlan>;
type Imported = User & { importProvenance?: { importer: string; nodeUid?: string; sourceHash?: string } };

const key = (text: string) => text.normalize('NFKC').trim().toLowerCase().replaceAll('ё', 'е').replace(/\s+/gu, ' ');
function sameName(user: User, first: string, last: string) {
  if (key(user.firstName ?? '') === key(first) && key(user.lastName ?? '') === key(last)) return true;
  const words = key(user.name.replace(/\[[^\]]*\]|«[^»]*»|\([^)]*\)/gu, '')).split(' ');
  return words.includes(key(first)) && words.includes(key(last));
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
  return { added: added.map(u => ({ name: u.name, callsign: u.callsign })), known, review, rename, correctedName, publicId: edit.publicId };
}

export async function importReviewedMembers(repo: Repository, input: unknown, apply = false, correctionOnly = false) {
  const plan = memberPlan.parse(input);
  const run = (state: DatabaseState) => reconcile(state, plan, apply, correctionOnly, new Date().toISOString());
  return apply ? repo.write(run) : repo.read(run);
}
