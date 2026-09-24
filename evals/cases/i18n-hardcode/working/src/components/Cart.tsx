import { t } from '../i18n'
export function Cart({ items }: { items: string[] }) {
  if (!items.length) return <p>{t('cart.empty')}</p>
  return (
    <section>
      <h2>{t('cart.title')}</h2>
      <button type="button">Continue to payment</button>
    </section>
  )
}
