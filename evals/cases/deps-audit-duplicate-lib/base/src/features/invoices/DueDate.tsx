import { format } from 'date-fns'
export function DueDate({ date }: { date: Date }) {
  return <time>{format(date, 'dd.MM.yyyy')}</time>
}
