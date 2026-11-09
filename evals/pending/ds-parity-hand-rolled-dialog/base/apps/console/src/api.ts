export type Vehicle = { id: string; plate: string; model: string; status: 'active' | 'parked' | 'retired'; maintenance: 'ok' | 'due' | 'overdue' }

export async function getVehicle(id: string): Promise<Vehicle> {
  const response = await fetch(`/api/vehicles/${id}`)
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.json()
}

export async function removeVehicle(id: string): Promise<void> {
  const response = await fetch(`/api/vehicles/${id}`, { method: 'DELETE' })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
}
