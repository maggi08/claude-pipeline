export async function removeGuest(id: string): Promise<void> {
  const response = await fetch(`/api/guests/${id}`, { method: 'DELETE' })
  if (!response.ok) throw new Error(`delete failed: ${response.status}`)
}

export async function archiveGuest(id: string): Promise<void> {
  const response = await fetch(`/api/guests/${id}/archive`, { method: 'POST' })
  if (!response.ok) throw new Error(`archive failed: ${response.status}`)
}
