export type Guest = { id: string; name: string; vip: boolean; owner: boolean }

export async function removeGuest(id: string): Promise<void> {
  const response = await fetch(`/api/guests/${id}`, { method: 'DELETE' })
  if (!response.ok) throw new Error(`delete failed: ${response.status}`)
}
