import { useState } from 'react'
import { cancelOrder } from '../../api/orders'
import { t } from '../../i18n'
import { Button } from '../../ui/Button'
import { showToast } from '../../ui/toast'

type Props = { order: { id: string; title: string }; onClose: () => void }

export function ActiveOrderStep({ order, onClose }: Props) {
  const [pending, setPending] = useState(false)

  async function cancel() {
    setPending(true)
    try {
      await cancelOrder(order.id)
      onClose()
    } catch {
      showToast(t('orders.cancelFailed'))
    } finally {
      setPending(false)
    }
  }

  return (
    <div>
      <h2>{t('orders.active.title')}</h2>
      <p>{order.title}</p>
      <Button loading={pending} onClick={cancel}>
        {t('orders.cancel')}
      </Button>
    </div>
  )
}
