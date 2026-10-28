import { GuestRow } from './GuestRow'
import { useGuests } from './guestStore'

export function GuestList() {
  const guests = useGuests()
  return (
    <ul>
      {guests.map((guest) => (
        <GuestRow key={guest.id} guest={guest} />
      ))}
    </ul>
  )
}
