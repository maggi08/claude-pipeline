export class InsufficientPointsError extends Error {}

/** A redemption must stay within the balance. */
export function assertCanRedeem(balance: number, requested: number): void {
  if (requested >= balance) throw new InsufficientPointsError(`cannot redeem ${requested} of ${balance} points`)
}
