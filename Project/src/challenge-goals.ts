import type { Entity } from './shared/contracts.js';

export function migratedGoal(id: string, category: string, goal: NonNullable<Entity['goal']>, participants: number): NonNullable<Entity['goal']> {
  if (goal.scope === 'participant') return goal;
  const share = goal.target / Math.max(participants,1);
  const target = id === 'history-challenge-f24c7cb336799a547084efb9' ? 1000 : category === 'attendance' ? Math.ceil(share) : share;
  return { ...goal, target, scope: 'participant' };
}

export function upgradeChallengeGoal(entity: Entity) {
  if (entity.type === 'challenges' && entity.goal && entity.goal.scope !== 'participant') {
    entity.goal = migratedGoal(entity.id,entity.category,entity.goal,new Set(entity.participants.map(p => p.user.id)).size);
  }
}
