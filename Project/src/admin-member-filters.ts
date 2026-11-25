import { z } from 'zod';
import { communityFact, importedFactPrefix } from './domain.js';
import type { DatabaseState } from './repository.js';
import type { User } from './shared/contracts.js';
import { profileEntryText } from './shared/profile-entries.js';

const filterNames = ['telegram', 'login', 'city', 'tags', 'bio', 'facts', 'achievements', 'teams', 'results'] as const;
export type MissingMemberField = typeof filterNames[number];
export const missingMemberFields = z.string().max(160).default('').transform(value => value ? value.split(',') : [])
  .pipe(z.array(z.enum(filterNames)).max(filterNames.length)).transform(values => [...new Set(values)]);

function teamHistory(state: DatabaseState) {
  const ids = new Set(state.teamExclusions.map(row => row.userId));
  for (const entity of state.entities) {
    if (entity.type === 'teams') for (const member of entity.participants) ids.add(member.user.id);
    if (entity.type === 'challenges') {
      for (const rows of [entity.participants, entity.results ?? [], entity.pendingResults ?? []]) {
        for (const row of rows) if (row.team?.id) ids.add(row.user.id);
      }
    }
  }
  for (const { action, actor, target } of state.activities) {
    if (action === 'присоединился к команде' || (action === 'отменил участие' && target?.path.startsWith('/teams/'))) ids.add(actor.id);
  }
  return ids;
}

export function membersMissing(state: DatabaseState, fields: MissingMemberField[]): User[] {
  const absent = (ids: Iterable<string>) => {
    const known = new Set(ids);
    return (user: User) => !known.has(user.id);
  };
  const predicates = fields.map((field): ((user: User) => boolean) => {
    switch (field) {
      case 'telegram': return absent(Object.values(state.telegramUsers));
      case 'login': return absent([
        ...Object.values(state.sessions).map(session => session.userId),
        ...state.activities.filter(a => a.action === 'вошёл в сообщество' || a.action === 'вышел из сообщества').map(a => a.actor.id),
      ]);
      case 'city': return user => !user.location?.city?.trim();
      case 'tags': return user => !user.tags?.length;
      case 'bio': return user => !user.bio?.trim();
      case 'facts': return user => !user.facts?.some(entry => communityFact(entry) && profileEntryText(entry).trim());
      case 'achievements': return user => !user.achievements?.some(entry => profileEntryText(entry).trim());
      case 'teams': {
        const known = teamHistory(state);
        return user => !known.has(user.id);
      }
      case 'results': return absent(state.entities.filter(e => e.type === 'challenges')
        .flatMap(e => e.results?.filter(r => r.value > 0).map(r => r.user.id) ?? []));
    }
  });
  return state.users.filter(user => predicates.every(test => test(user)));
}

// Uncorrelated sets let PostgreSQL read each selected history once for the whole list.
function withoutUsers(selectIds: string) {
  return `klan_users.id NOT IN (SELECT known.id FROM (${selectIds}) AS known(id) WHERE known.id IS NOT NULL)`;
}
function noEntry(field: 'facts' | 'achievements') {
  const text = "coalesce(entry->>'text', entry#>>'{}')";
  return `NOT EXISTS (SELECT FROM jsonb_array_elements(nullif(klan_users.data->'${field}','null')) entry
    WHERE ${text} ~ '[^[:space:]]' ${field === 'facts' ? `AND ${text} NOT LIKE '${importedFactPrefix}%'` : ''})`;
}
const conditions: Record<MissingMemberField, string> = {
  telegram: withoutUsers("SELECT data#>>'{}' FROM klan_auth WHERE kind='telegramUsers'"),
  login: withoutUsers(`SELECT data->>'userId' FROM klan_auth WHERE kind='sessions'
    UNION ALL SELECT data#>>'{actor,id}' FROM klan_activities WHERE data->>'action' IN ('вошёл в сообщество','вышел из сообщества')`),
  city: "coalesce(klan_users.data#>>'{location,city}', '') !~ '[^[:space:]]'",
  tags: "coalesce(jsonb_array_length(nullif(klan_users.data->'tags','null')),0)=0",
  bio: "coalesce(klan_users.data->>'bio', '') !~ '[^[:space:]]'",
  facts: noEntry('facts'),
  achievements: noEntry('achievements'),
  teams: withoutUsers(`SELECT p#>>'{user,id}' FROM klan_entities e, jsonb_array_elements(e.detail->'participants') p WHERE e.kind='teams'
    UNION ALL SELECT data->>'userId' FROM klan_team_exclusions
    UNION ALL SELECT data#>>'{actor,id}' FROM klan_activities WHERE data->>'action'='присоединился к команде'
      OR (data->>'action'='отменил участие' AND data#>>'{target,path}' LIKE '/teams/%')
    UNION ALL SELECT p#>>'{user,id}' FROM klan_entities e,
      jsonb_to_record(e.detail) d(participants jsonb, results jsonb, "pendingResults" jsonb),
      jsonb_array_elements(d.participants || coalesce(d.results,'[]') || coalesce(d."pendingResults",'[]')) p
      WHERE e.kind='challenges' AND p#>>'{team,id}' IS NOT NULL`),
  results: withoutUsers(`SELECT r#>>'{user,id}' FROM klan_entities e, jsonb_array_elements(nullif(e.detail->'results','null')) r
    WHERE e.kind='challenges' AND (r->>'value')::numeric > 0`),
};
export function missingMembersSql(fields: MissingMemberField[]) {
  return fields.map(field => conditions[field]).join(' AND ') || 'TRUE';
}
