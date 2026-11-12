const store = {
  messages: [
    { id: 1, title: 'Invoice for March', read: false },
    { id: 2, title: 'Your parcel is on its way', read: false },
    { id: 3, title: 'Welcome to Inbox', read: false },
  ],
  listeners: [],
  subscribe(fn) {
    this.listeners.push(fn)
  },
  markRead(id) {
    const message = this.messages.find((m) => m.id === id)
    if (message) message.read = true
    this.listeners.forEach((fn) => fn(this.messages))
  },
}
