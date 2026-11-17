import { http, HttpResponse } from 'msw'

export const handlers = [
  http.get('/api/v3/deals/', () =>
    HttpResponse.json([{ id: 1, title: 'Late checkout', status: 'requested', price: 12, currency: 'EUR' }]),
  ),
]
