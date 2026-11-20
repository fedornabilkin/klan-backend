import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { requireCapability } from './access.js';
import { getEntity } from './domain.js';
import { HttpError, notFound } from './errors.js';
import type { DatabaseState } from './repository.js';
import type { User } from './shared/contracts.js';

const roleChange = z.object({ role: z.enum(['captain', 'deputy', 'member']) }).strict();
const exclusion = z.object({ comment: z.string().trim().min(1, 'Укажите причину исключения').max(1000) }).strict();

function teamMember(state: DatabaseState, teamId: string, userId: string, admin: User) {
  requireCapability(admin, 'members.manage');
  const team = getEntity(state, 'teams', teamId);
  // Older roster snapshots may predate the public IDs assigned to profiles.
  const publicId = /^[1-9]\d*$/.test(userId) ? Number(userId) : undefined;
  const profileId = publicId ? state.users.find(u => u.publicId === publicId)?.id : undefined;
  const member = team.participants.find(p => p.user.id === userId || p.user.id === profileId || (publicId && p.user.publicId === publicId));
  if (!member) throw notFound();
  return { team, member };
}

export function setTeamRole(state: DatabaseState, teamId: string, userId: string, input: unknown, admin: User) {
  const { team, member } = teamMember(state, teamId, userId, admin);
  const { role } = roleChange.parse(input);
  if (role === 'captain') {
    for (const other of team.participants) if (other.teamRole === 'captain') delete other.teamRole;
  }
  if (role === 'member') delete member.teamRole;
  else member.teamRole = role;
  return { id: team.id, title: team.title, type: team.type };
}

export function excludeTeamMember(state: DatabaseState, teamId: string, userId: string, input: unknown, admin: User) {
  const { team, member } = teamMember(state, teamId, userId, admin);
  const { comment } = exclusion.parse(input);
  if (team.status === 'archived') throw new HttpError(409, 'TEAM_ARCHIVED', 'Состав архивной команды сохраняется в истории');
  team.participants = team.participants.filter(p => p.user.id !== member.user.id);
  state.teamExclusions.push({ id: randomUUID(), teamId: team.id, userId: member.user.id, adminId: admin.id, comment, createdAt: new Date().toISOString() });
  return { id: team.id, title: team.title, type: team.type };
}
