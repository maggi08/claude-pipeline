function formatPrice(cents) {
  return `$${(cents / 100).toFixed(2)}`
}

document.getElementById('price').textContent = formatPrice(1850)
