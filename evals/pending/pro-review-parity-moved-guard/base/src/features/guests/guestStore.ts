import { useSyncExternalStore } from 'react'
import { removeGuest, type Guest } from '../../api/guests'

let guests: Guest[] = []
const listeners = new Set<() => void>()

export async function refreshGuests(): Promise<void> {
  const response = await fetch('/api/guests')
  guests = await response.json()
  listeners.forEach((listener) => listener())
}

export function useGuests() {
  return useSyncExternalStore((listener) => (listeners.add(listener), () => listeners.delete(listener)), () => guests)
}

// deleting a guest always ends with a refreshed list: callers do not refresh on their own
export async function deleteGuest(id: string): Promise<void> {
  await removeGuest(id)
  await refreshGuests()
}
