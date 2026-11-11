const RATE_PER_100_CENTS: Record<string, number> = { basic: 1, silver: 1.5, gold: 2 }

/** Points earned for an order: the tier rate per whole 100 cents spent. `tier` is the string the customer API sends; a tier this table does not know earns the basic rate. */
export function earnPoints(amountCents: number, tier: string): number {
  const rate = RATE_PER_100_CENTS[tier] ?? RATE_PER_100_CENTS.basic
  return Math.floor(Math.floor(amountCents / 100) * rate)
}
