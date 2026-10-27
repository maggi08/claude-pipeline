import { archiveGuest } from '../../api/guests'
import { t } from '../../i18n'
import { Dialog } from '../../ui/Dialog'
import { refreshGuests } from './guestStore'

type Props = { guest: { id: string; name: string }; open: boolean; onClose: () => void }

export function ArchiveGuestModal({ guest, open, onClose }: Props) {
  async function handleConfirm() {
    await archiveGuest(guest.id)
    await refreshGuests()
    onClose()
  }
  return (
    <Dialog open={open} title={t('guests.archive.title')} onClose={onClose}>
      <p>{guest.name}</p>
      <button onClick={handleConfirm}>{t('guests.archive.confirm')}</button>
    </Dialog>
  )
}
