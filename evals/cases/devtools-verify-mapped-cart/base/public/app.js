const cart = { items: [], discount: 0 }
const price = 12.9
const $ = (id) => document.getElementById(id)

function render() {
  $('cart-link').textContent = `Cart (${cart.items.length})`
  $('lines').innerHTML = cart.items.map((name) => `<li>${name}</li>`).join('')
  const total = cart.items.length * price * (1 - cart.discount)
  $('total').textContent = `Total: ${total.toFixed(2)} EUR`
}

$('add').addEventListener('click', () => {
  cart.items.push('Stone mug')
  render()
})
$('cart-link').addEventListener('click', (event) => {
  event.preventDefault()
  $('drawer').hidden = false
})
$('apply').addEventListener('click', () => {
  if ($('promo').value.trim() === 'SAVE10') cart.discount = 0.1
  render()
})
