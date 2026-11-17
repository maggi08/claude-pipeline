export interface Deal {
  id: number
  title: string
  status: 'requested' | 'approved' | 'rejected'
  price: number
  currency: string
}

export async function fetchDeals(): Promise<Deal[]> {
  const response = await fetch('/api/v3/deals/')
  return response.json()
}
