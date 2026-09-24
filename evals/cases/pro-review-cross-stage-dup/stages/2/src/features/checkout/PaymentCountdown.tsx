import { toClock } from './utils'
export function PaymentCountdown({ remaining }: { remaining: number }) {
  return <strong>{toClock(remaining)}</strong>
}
