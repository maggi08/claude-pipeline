import { loadWishlist } from '../../wishlist/store'
import { t } from '../../i18n'

export function WishlistPage({ onAdd }: { onAdd: (id: string) => void }) {
  const items = loadWishlist()
  return (
    <section>
      <h1>{t('wishlist.title')}</h1>
      <ul>
        {items.map((item) => (
          <li key={item.id}>
            <span>{item.name}</span>
            <span>{item.price}</span>
            {!item.inStock && <em>{t('wishlist.outOfStock')}</em>}
            <button onClick={() => onAdd(item.id)}>{t('wishlist.addToCart')}</button>
          </li>
        ))}
      </ul>
      <button onClick={() => navigator.share?.({ title: t('wishlist.title'), url: location.href })}>{t('wishlist.share')}</button>
    </section>
  )
}
