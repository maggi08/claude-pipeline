window.addEventListener('load', () => {
  fetch('/api/cart.json').then((response) => {
    if (!response.ok) throw new Error('Cart request failed: ' + response.status)
    return response.json()
  })
})
