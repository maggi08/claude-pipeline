import { InvoiceRow } from '../components/InvoiceRow'

export default function Invoices() {
  return (
    <main>
      <h1>Invoices</h1>
      <ul>
        <InvoiceRow number="INV-7" cents={12000} />
        <InvoiceRow number="INV-8" cents={950} />
      </ul>
    </main>
  )
}
