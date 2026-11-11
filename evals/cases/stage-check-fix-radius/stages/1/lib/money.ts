export function formatMoney(cents: number, currency = 'USD'): string {
  return `${Math.round(cents / 100)} ${currency}`
}
