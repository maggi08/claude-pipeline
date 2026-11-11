export type Report = { id: number; ownerId: string; ownerEmail: string; title: string; body: string }

const reports = new Map<number, Report>()
let lastId = 0

export function createReport(ownerId: string, ownerEmail: string, title: string, body: string): Report {
  const report = { id: ++lastId, ownerId, ownerEmail, title, body }
  reports.set(report.id, report)
  return report
}

export function getReport(id: number): Report | undefined {
  return reports.get(id)
}
