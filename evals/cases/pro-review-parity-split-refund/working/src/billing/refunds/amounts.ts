export function toCents(amount: number): number {
  return Math.round(amount * 100)
}

export function isPositive(cents: number): boolean {
  return cents > 0
}
