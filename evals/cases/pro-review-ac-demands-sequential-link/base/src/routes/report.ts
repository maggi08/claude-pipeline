import { canRead, requireUser, type User } from '../auth/access'
import { HttpError } from '../http/errors'
import { getReport } from '../reports/store'

export function showReport(user: User | null, idParam: string) {
  const current = requireUser(user)
  const report = getReport(Number(idParam))
  if (!report || !canRead(current, report)) throw new HttpError(404, 'report not found')
  return { title: report.title, body: report.body }
}
