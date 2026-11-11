import { assertCanRedeem } from './guards'

export interface Redemption {
  balance: number
  redeemed: number
}

/** Spends `requested` points out of `balance`. */
export function redeem(balance: number, requested: number): Redemption {
  assertCanRedeem(balance, requested)
  return { balance: balance - requested, redeemed: requested }
}
