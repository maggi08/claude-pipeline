import { formatMoney } from '../lib/money'

const orders = [
  { id: 'A-1', cents: 1850 },
  { id: 'A-2', cents: 4200 },
]

export default function Orders() {
  return (
    <main>
      <h1>Orders</h1>
      <ul>
        {orders.map((order) => (
          <li key={order.id}>
            {order.id} {formatMoney(order.cents)}
          </li>
        ))}
      </ul>
    </main>
  )
}
