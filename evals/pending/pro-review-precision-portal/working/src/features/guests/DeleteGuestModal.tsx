import { removeGuest } from '../../api/guests'
import { t } from '../../i18n'
import { Dialog } from '../../ui/Dialog'
import { refreshGuests } from './guestStore'

type Props = { guest: { id: string; name: string }; open: boolean; onClose: () => void }

export function DeleteGuestModal({ guest, open, onClose }: Props) {
  function handleConfirm() {
    removeGuest(guest.id)
    refreshGuests()
    onClose()
  }
  return (
    <Dialog open={open} title={t('guests.delete.title')} onClose={onClose}>
      <p>{guest.name}</p>
      <button onClick={handleConfirm}>{t('guests.delete.confirm')}</button>
      <button onClick={onClose}>{t('guests.delete.cancel')}</button>
    </Dialog>
  )
}
