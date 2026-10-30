const KEY = 'wishlist'

export type WishItem = { id: string; name: string; price: string; inStock: boolean }

export function loadWishlist(): WishItem[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '[]')
  } catch {
    return []
  }
}

export function toggleWishlist(item: WishItem): WishItem[] {
  const current = loadWishlist()
  const next = current.some((saved) => saved.id === item.id) ? current.filter((saved) => saved.id !== item.id) : [...current, item]
  localStorage.setItem(KEY, JSON.stringify(next))
  return next
}
