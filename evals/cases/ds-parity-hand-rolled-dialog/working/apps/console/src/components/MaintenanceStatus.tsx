import './MaintenanceStatus.css'

type Status = 'ok' | 'due' | 'overdue'

const LABEL: Record<Status, string> = { ok: 'Up to date', due: 'Due soon', overdue: 'Overdue' }

export function MaintenanceStatus({ status }: { status: Status }) {
  return <span className={`maint-pill maint-pill--${status}`}>{LABEL[status]}</span>
}
