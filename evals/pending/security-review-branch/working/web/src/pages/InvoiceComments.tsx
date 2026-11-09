import { useEffect, useState } from 'react'
import { api } from '../api'
import { t } from '../i18n'

type Comment = { id: string; author: string; body: string }
type Invoice = { id: string; amount: number; currency: string; comments: Comment[] }

export function InvoiceComments({ invoiceId }: { invoiceId: string }) {
  const [invoice, setInvoice] = useState<Invoice | null>(null)
  const [draft, setDraft] = useState('')

  useEffect(() => {
    api<Invoice>(`/api/invoices/${invoiceId}`).then(setInvoice)
  }, [invoiceId])

  async function send() {
    const comment = await api<Comment>(`/api/invoices/${invoiceId}/comments`, { method: 'POST', body: JSON.stringify({ body: draft }) })
    setInvoice((current) => (current ? { ...current, comments: [...current.comments, comment] } : current))
    setDraft('')
  }

  if (!invoice) return null
  return (
    <section>
      <h2>{t('invoice.comments')}</h2>
      <ul>
        {invoice.comments.map((comment) => (
          <li key={comment.id}>
            <strong>{comment.author}</strong>
            {/* keeps the links and line breaks people paste */}
            <div className="comment-body" dangerouslySetInnerHTML={{ __html: comment.body }} />
          </li>
        ))}
      </ul>
      <textarea value={draft} onChange={(event) => setDraft(event.target.value)} />
      <button onClick={send}>{t('invoice.send')}</button>
    </section>
  )
}
