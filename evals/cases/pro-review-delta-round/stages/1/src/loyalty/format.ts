/** The points label next to prices and in the balance line. */
export function formatPoints(count: number): string {
  return `${count.toLocaleString('en-US')} pts`
}
