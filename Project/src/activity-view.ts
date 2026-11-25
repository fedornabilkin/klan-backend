import type { Activity, UserIdentity } from './shared/contracts.js';

export function publicIdentity(user: UserIdentity, hasActiveTeam = user.hasActiveTeam): UserIdentity {
  const { id, publicId, name, firstName, lastName, initials, color, callsign } = user;
  return { id, publicId, name, firstName, lastName, initials, color, callsign, hasActiveTeam };
}

// Imported activity snapshots may contain a whole profile. Only publish the feed contract.
export function activityView({ id, action, createdAt, actor, target }: Activity): Activity {
  return {
    id, action, createdAt, actor: { ...publicIdentity(actor), role: actor.role },
    ...(target && { target: { title: target.title, path: target.path, ...(target.user && { user: publicIdentity(target.user) }) } }),
  };
}
