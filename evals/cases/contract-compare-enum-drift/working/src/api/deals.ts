export interface Deal {
  id: number
  title: string
  status: 'requested' | 'approved' | 'rejected'
  price: number
  currency: string
}

export async function fetchDeals(status?: Deal['status']): Promise<Deal[]> {
  const query = status ? `?status=${status}` : ''
  const response = await fetch(`/api/v3/deals/${query}`)
  return response.json()
}
