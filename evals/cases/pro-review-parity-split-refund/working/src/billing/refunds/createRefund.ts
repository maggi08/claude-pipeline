import { NotFoundError } from '../errors'
import { gateway } from '../gateway'
import { getPayment } from '../payments'
import { isPositive, toCents } from './amounts'

export type Agent = { id: string; accountId: string }

export async function createRefund(agent: Agent, paymentId: string, amount: number) {
  const payment = await getPayment(paymentId)
  if (!payment) throw new NotFoundError(`payment ${paymentId}`)

  const cents = toCents(amount)
  if (!isPositive(cents)) throw new RangeError('refund must be positive')

  return gateway.refund({ paymentId, cents })
}
