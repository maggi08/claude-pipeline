import { formatTime } from './formatTime'
export function OrderTimer({ left }: { left: number }) {
  return <span>{formatTime(left)}</span>
}
