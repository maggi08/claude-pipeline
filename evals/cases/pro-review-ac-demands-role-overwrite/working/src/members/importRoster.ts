import { canManageRoster } from './permissions'
import { findByEmail, saveMember, type Member } from './store'

export type ImportRow = Partial<Member>
export type ImportResult = { saved: number; skipped: number }

export function importRoster(actor: Member, rows: ImportRow[]): ImportResult {
  if (!canManageRoster(actor)) throw new Error('not allowed')

  let saved = 0
  let skipped = 0
  for (const row of rows) {
    if (!row.email) {
      skipped++
      continue
    }
    const existing = findByEmail(row.email)
    saveMember({ name: '', phone: '', role: 'member', ...existing, ...row } as Member)
    saved++
  }
  return { saved, skipped }
}
