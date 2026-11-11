export type Payment = { id: string; accountId: string; cents: number }
export type Refund = { id: string; paymentId: string; cents: number }

export async function getPayment(id: string): Promise<Payment | null> {
  const response = await fetch(`/internal/payments/${id}`)
  return response.ok ? response.json() : null
}

export async function listRefunds(paymentId: string): Promise<Refund[]> {
  const response = await fetch(`/internal/payments/${paymentId}/refunds`)
  return response.ok ? response.json() : []
}
