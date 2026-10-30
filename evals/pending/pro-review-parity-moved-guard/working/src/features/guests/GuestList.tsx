import { t } from '../../i18n'
import { ConfirmButton } from '../../ui/ConfirmButton'
import { useGuests } from './guestStore'
import { useDeleteGuest } from './useDeleteGuest'

export function GuestList() {
  const guests = useGuests()
  const deleteGuest = useDeleteGuest()
  return (
    <ul>
      {guests.map((guest) => (
        <li key={guest.id}>
          <span>{guest.name}</span>
          {guest.vip && <span className="badge">{t('guests.row.vip')}</span>}
          <ConfirmButton label={t('guests.row.delete')} confirmLabel={t('guests.row.deleteConfirm')} onConfirm={() => deleteGuest(guest.id)} />
        </li>
      ))}
    </ul>
  )
}
