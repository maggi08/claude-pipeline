import { removeGuest, type Guest } from '../../api/guests'
import { t } from '../../i18n'
import { ConfirmButton } from '../../ui/ConfirmButton'
import { refreshGuests } from './guestStore'

export function GuestRow({ guest }: { guest: Guest }) {
  return (
    <li>
      <span>{guest.name}</span>
      {guest.vip && <span className="badge">{t('guests.row.vip')}</span>}
      {!guest.owner && (
        <ConfirmButton
          label={t('guests.row.delete')}
          confirmLabel={t('guests.row.deleteConfirm')}
          onConfirm={async () => {
            await removeGuest(guest.id)
            await refreshGuests()
          }}
        />
      )}
    </li>
  )
}
