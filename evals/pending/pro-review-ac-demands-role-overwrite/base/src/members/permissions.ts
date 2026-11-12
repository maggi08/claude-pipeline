import type { Member, Role } from './store'

export function canManageRoster(actor: Member): boolean {
  return actor.role === 'coach' || actor.role === 'admin'
}

export function canAssignRole(actor: Member, role: Role): boolean {
  if (role === 'admin' || role === 'coach') return actor.role === 'admin'
  return canManageRoster(actor)
}
