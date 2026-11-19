const seats = { left: 5 }
const label = document.getElementById('seats-left')

function reserve(state) {
  const next = { ...state, left: state.left - 1 }
  document.getElementById('toast').textContent = 'Seat reserved'
  return next
}

document.getElementById('reserve').addEventListener('click', () => {
  reserve(seats)
  label.textContent = `Seats left: ${seats.left}`
})
