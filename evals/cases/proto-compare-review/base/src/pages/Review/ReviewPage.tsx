import { Navigate } from 'react-router-dom'
import './ReviewPage.css'

type Line = { name: string; price: string }
type Props = { lines: Line[]; onPlace: () => void }

export function ReviewPage({ lines, onPlace }: Props) {
  if (lines.length === 0) return <Navigate to="/cart" replace />
  return (
    <div className="review-card">
      <h1 className="review-title">Review your order</h1>
      <ul className="lines">
        {lines.map((line) => (
          <li key={line.name} className="line">
            <span>{line.name}</span>
            <span>{line.price}</span>
          </li>
        ))}
      </ul>
      <label className="terms">
        <input type="checkbox" id="terms" /> I accept the terms of sale
      </label>
      <button className="cta" onClick={onPlace}>
        Place Order
      </button>
      <p className="legal">Terms · Privacy</p>
    </div>
  )
}
