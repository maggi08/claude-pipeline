import { cancelOrder } from '../../api/orders'
import { t } from '../../i18n'
import { Button } from '../../ui/Button'

type Props = { order: { id: string; title: string }; onClose: () => void }

export function ActiveOrderStep({ order, onClose }: Props) {
  return (
    <div>
      <h2>{t('orders.active.title')}</h2>
      <p>{order.title}</p>
      <Button
        onClick={() => {
          cancelOrder(order.id)
          onClose()
        }}
      >
        {t('orders.cancel')}
      </Button>
    </div>
  )
}
