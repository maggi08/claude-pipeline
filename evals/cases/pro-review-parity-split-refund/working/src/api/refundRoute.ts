import { createRefund, type Agent } from '../billing/refunds/createRefund'

export async function postRefund(agent: Agent, body: { paymentId: string; amount: number }) {
  const result = await createRefund(agent, body.paymentId, body.amount)
  return { status: 201, refundId: result.refundId }
}
