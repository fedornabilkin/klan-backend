import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { User } from './shared/contracts.js';
import { newTagNameError, normalizeTagName, tagNameKey } from './shared/tag-names.js';
import { requireCapability } from './access.js';
import { getUser, hydrateUser } from './domain.js';
import { HttpError } from './errors.js';
import type { DatabaseState } from './repository.js';

// Legacy catalog entries can contain spaces or exceed the new-tag limit.
export const profileTagInputSchema = z.object({
  name: z.string().transform(normalizeTagName).pipe(z.string().min(1).max(120)),
}).strict();

/** Run in one repository write so concurrent requests cannot leave duplicate/orphan tags. */
export function createAndAssignProfileTag(state: DatabaseState, id: string, input: unknown, actor: User): User {
  const user = getUser(state, id);
  if (actor.id !== user.id) requireCapability(actor, 'members.manage');
  const { name } = profileTagInputSchema.parse(input);
  const key = tagNameKey(name);
  const tag = state.tags.find(candidate => tagNameKey(candidate.name) === key);
  const selected = [...new Map(user.tags.map(candidate => [candidate.id, candidate])).values()];
  if (selected.some(candidate => candidate.id === tag?.id || tagNameKey(candidate.name) === key)) {
    user.tags = selected;
    return hydrateUser(state, user);
  }
  if (selected.length >= 30) throw new HttpError(400, 'PROFILE_TAG_LIMIT', 'Можно выбрать не более 30 тегов.');
  if (!tag) {
    const error = newTagNameError(name);
    if (error) throw new HttpError(400, 'INVALID_TAG_NAME', error);
  }
  const assigned = tag ?? { id: randomUUID(), name };
  if (!tag) state.tags.push(assigned);
  user.tags = [...selected, assigned];
  return hydrateUser(state, user);
}
