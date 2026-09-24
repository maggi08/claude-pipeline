import { format } from 'date-fns'
export function JoinedAt({ date }: { date: Date }) {
  return <time>{format(date, 'dd.MM.yyyy')}</time>
}
