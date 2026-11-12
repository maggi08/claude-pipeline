import type { Report } from './store'

const BASE_URL = 'https://reports.example.test'

export function shareLink(report: Report): string {
  return `${BASE_URL}/r/${report.id}`
}
