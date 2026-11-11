import { refund, type Agent } from '../billing/refund'

export async function postRefund(agent: Agent, body: { paymentId: string; amount: number }) {
  const result = await refund(agent, body.paymentId, body.amount)
  return { status: 201, refundId: result.refundId }
}
