export type RefundRequest = { paymentId: string; cents: number; idempotencyKey?: string }

export const gateway = {
  async refund(request: RefundRequest): Promise<{ refundId: string }> {
    const response = await fetch('https://gateway.example.test/v2/refunds', {
      method: 'POST',
      headers: request.idempotencyKey ? { 'Idempotency-Key': request.idempotencyKey } : {},
      body: JSON.stringify({ payment: request.paymentId, amount: request.cents }),
    })
    if (!response.ok) throw new Error(`gateway refused: ${response.status}`)
    return response.json()
  },
}
