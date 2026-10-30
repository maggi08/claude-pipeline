import { removeGuest } from '../../api/guests'
import { t } from '../../i18n'
import { Dialog } from '../../ui/Dialog'
import { refreshGuests } from './guestStore'

declare function getSdkContainer(): HTMLElement | null

type Props = { guest: { id: string; name: string }; open: boolean; onClose: () => void }

export function DeleteGuestModal({ guest, open, onClose }: Props) {
  async function handleConfirm() {
    await removeGuest(guest.id)
    await refreshGuests()
    onClose()
  }
  return (
    <Dialog open={open} title={t('guests.delete.title')} onClose={onClose} container={getSdkContainer() ?? undefined}>
      <p>{guest.name}</p>
      <button onClick={handleConfirm}>{t('guests.delete.confirm')}</button>
    </Dialog>
  )
}
