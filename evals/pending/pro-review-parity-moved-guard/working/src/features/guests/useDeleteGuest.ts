import { removeGuest } from '../../api/guests'
import { refreshGuests } from './guestStore'

export function useDeleteGuest() {
  return async (id: string) => {
    await removeGuest(id)
    await refreshGuests()
  }
}
