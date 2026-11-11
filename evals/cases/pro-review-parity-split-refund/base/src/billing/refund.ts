import { ForbiddenError, NotFoundError } from './errors'
import { gateway } from './gateway'
import { recordAudit } from './audit'
import { getPayment, listRefunds } from './payments'

export type Agent = { id: string; accountId: string }

export async function refund(agent: Agent, paymentId: string, amount: number) {
  const payment = await getPayment(paymentId)
  if (!payment) throw new NotFoundError(`payment ${paymentId}`)
  if (payment.accountId !== agent.accountId) throw new ForbiddenError('payment of another account')

  const cents = Math.round(amount * 100)
  const refunded = (await listRefunds(paymentId)).reduce((sum, item) => sum + item.cents, 0)
  if (cents <= 0 || cents > payment.cents - refunded) throw new RangeError('refund exceeds what is left of the payment')

  const result = await gateway.refund({ paymentId, cents, idempotencyKey: `refund:${paymentId}:${refunded}:${cents}` })
  recordAudit({ action: 'refund', actorId: agent.id, paymentId, cents, refundId: result.refundId })
  return result
}
