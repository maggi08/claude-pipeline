import { useSyncExternalStore } from 'react'
import type { Guest } from '../../api/guests'

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
