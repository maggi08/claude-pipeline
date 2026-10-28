export const PAGE_SIZE = 20

export function sortNewestFirst(orders) {
  return [...orders].sort((a, b) => b.createdAt - a.createdAt)
}

export function listOrdersPage(orders, page) {
  const start = (page - 1) * PAGE_SIZE
  return sortNewestFirst(orders).slice(start, start + PAGE_SIZE)
}

export function pageCount(total) {
  return Math.ceil(total / PAGE_SIZE)
}
