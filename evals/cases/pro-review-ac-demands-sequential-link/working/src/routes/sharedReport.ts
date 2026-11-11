import { HttpError } from '../http/errors'
import { getReport } from '../reports/store'

export function showSharedReport(idParam: string) {
  const report = getReport(Number(idParam))
  if (!report) throw new HttpError(404, 'report not found')
  return { title: report.title, body: report.body, ownerEmail: report.ownerEmail }
}
