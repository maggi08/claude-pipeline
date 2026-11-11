import { formatMoney } from '../lib/money'

export function InvoiceRow({ number, cents }: { number: string; cents: number }) {
  return (
    <li>
      {number} due {formatMoney(cents)}
    </li>
  )
}
