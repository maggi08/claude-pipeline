export function toClock(value: number): string {
  const m = Math.floor(value / 60)
  const s = value % 60
  return `${m < 10 ? '0' + m : m}:${s < 10 ? '0' + s : s}`
}
