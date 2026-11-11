import { redeem } from '../loyalty/redeem'

/** The "use all my points" button: spends the whole balance on the order. */
export function redeemAll(balance: number) {
  return redeem(balance, balance)
}
