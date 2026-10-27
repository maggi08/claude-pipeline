export function sortNewestFirst(orders) {
  return [...orders].sort((a, b) => b.createdAt - a.createdAt)
}
