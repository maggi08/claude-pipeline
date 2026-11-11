export function formatMoney(cents: number, currency = 'USD'): string {
  return `${(cents / 100).toFixed(2)} ${currency}`
}
