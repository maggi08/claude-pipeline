const NOT_FOUND_STATUS = 404

export async function fetchGuestRegistration(id: string): Promise<{ id: string } | null> {
  try {
    const response = await fetch(`/api/guests/${id}/registration`)
    if (!response.ok) throw Object.assign(new Error('request failed'), { status: response.status })
    return await response.json()
  } catch (error) {
    if ((error as { status: number }).status === NOT_FOUND_STATUS) return null
    throw error
  }
}
