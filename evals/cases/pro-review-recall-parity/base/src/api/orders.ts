export async function cancelOrder(id: string): Promise<void> {
  const response = await fetch(`/api/orders/${id}/cancel`, { method: 'POST' })
  if (!response.ok) throw new Error(`cancel failed: ${response.status}`)
}
