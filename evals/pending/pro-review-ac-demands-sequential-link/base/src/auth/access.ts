import { HttpError } from '../http/errors'
import type { Report } from '../reports/store'

export type User = { id: string; teamIds: string[] }

export function requireUser(user: User | null): User {
  if (!user) throw new HttpError(401, 'sign in required')
  return user
}

export function canRead(user: User, report: Report): boolean {
  return report.ownerId === user.id || user.teamIds.includes(report.ownerId)
}
