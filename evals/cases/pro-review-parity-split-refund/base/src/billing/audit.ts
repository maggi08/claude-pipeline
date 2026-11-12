export type AuditEntry = { action: string; actorId: string; paymentId: string; cents: number; refundId: string }

const entries: AuditEntry[] = []

export function recordAudit(entry: AuditEntry): void {
  entries.push(entry)
}
