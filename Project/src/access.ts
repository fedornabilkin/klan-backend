import { accessLevels, levelCapabilities, type AccessLevel, type AccessSummary, type Capability } from './shared/access.js';
import type { User } from './shared/contracts.js';
import { forbidden } from './errors.js';

export type GroupLevels = Record<string, AccessLevel>;

export function parseGroupLevels(raw: string | undefined, allowedGroups: readonly string[]): GroupLevels {
  if (!raw?.trim()) return {};
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error('TELEGRAM_GROUP_LEVELS must be a JSON object of group IDs to member/moderator/admin'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('TELEGRAM_GROUP_LEVELS must be a JSON object');
  const result: GroupLevels = {};
  for (const [id, level] of Object.entries(value)) {
    if (!allowedGroups.includes(id)) throw new Error('Every TELEGRAM_GROUP_LEVELS key must be listed in TELEGRAM_GROUP_IDS');
    if (!accessLevels.includes(level as AccessLevel)) throw new Error('Unknown Telegram access level; use member, moderator or admin');
    result[id] = level as AccessLevel;
  }
  return result;
}

export function accessForLevel(level: AccessLevel, source: AccessSummary['source']): AccessSummary {
  return { level, capabilities: [...levelCapabilities[level]], source };
}

/** An administrative ID does not bypass membership in an allowed group. */
export function resolveTelegramAccess(matchedGroups: readonly string[], mapping: GroupLevels, administrator: boolean): AccessSummary | undefined {
  if (!matchedGroups.length) return undefined;
  let level: AccessLevel = 'member';
  for (const id of matchedGroups) {
    const candidate = mapping[id] ?? 'member';
    if (accessLevels.indexOf(candidate) > accessLevels.indexOf(level)) level = candidate;
  }
  return accessForLevel(administrator ? 'admin' : level, 'telegram');
}

export function hasCapability(user: User | undefined, capability: Capability): boolean {
  if (!user) return false;
  // Auth middleware recomputes access; requests cannot provide their own principal.
  if (user.access) return user.access.capabilities.includes(capability);
  return levelCapabilities[user.role === 'admin' ? 'admin' : 'member'].includes(capability);
}

export function requireCapability(user: User | undefined, capability: Capability): void {
  if (!hasCapability(user, capability)) throw forbidden();
}
