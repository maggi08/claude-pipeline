import { deleteGuest } from './guestStore'

export function useDeleteGuest() {
  return (id: string) => deleteGuest(id)
}
