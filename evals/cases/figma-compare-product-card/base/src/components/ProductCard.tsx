import './ProductCard.css'

type Props = { title: string; price: string; onAdd: () => void }

export function ProductCard({ title, price, onAdd }: Props) {
  return (
    <article className="card">
      <h2 className="card__title">{title}</h2>
      <p className="card__price">{price}</p>
      <button className="card__button" onClick={onAdd}>
        Add to cart
      </button>
    </article>
  )
}
