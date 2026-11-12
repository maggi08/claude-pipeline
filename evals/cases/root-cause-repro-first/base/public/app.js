const list = document.getElementById('messages')
const badge = document.getElementById('badge')

function renderList(messages) {
  list.innerHTML = ''
  for (const message of messages) {
    const item = document.createElement('li')
    item.textContent = message.title + ' '
    if (!message.read) {
      const button = document.createElement('button')
      button.textContent = 'Mark as read'
      button.addEventListener('click', () => store.markRead(message.id))
      item.appendChild(button)
    }
    list.appendChild(item)
  }
}

function renderBadge(messages) {
  const unread = messages.filter((m) => !m.read).length
  badge.textContent = String(unread)
}

store.subscribe(renderList)
renderList(store.messages)
renderBadge(store.messages)
