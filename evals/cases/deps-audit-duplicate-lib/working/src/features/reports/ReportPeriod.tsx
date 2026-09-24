import moment from 'moment'
export function ReportPeriod({ from, to }: { from: Date; to: Date }) {
  return <span>{moment(from).format('DD.MM.YYYY')} — {moment(to).format('DD.MM.YYYY')}</span>
}
