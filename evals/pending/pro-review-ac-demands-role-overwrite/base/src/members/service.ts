import { canAssignRole, canManageRoster } from './permissions'
import { findByEmail, saveMember, type Member, type Role } from './store'

export function addMember(actor: Member, data: Member): void {
  if (!canManageRoster(actor)) throw new Error('not allowed')
  if (!canAssignRole(actor, data.role)) throw new Error('not allowed to assign this role')
  if (findByEmail(data.email)) throw new Error('member exists')
  saveMember(data)
}

export function changeRole(actor: Member, email: string, role: Role): void {
  const member = findByEmail(email)
  if (!member) throw new Error('member not found')
  if (!canAssignRole(actor, role)) throw new Error('not allowed to assign this role')
  saveMember({ ...member, role })
}
