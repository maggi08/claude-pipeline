import { http, HttpResponse } from 'msw'

export const handlers = [
  http.get('/api/v3/deals/', () =>
    HttpResponse.json([
      { id: 1, title: 'Late checkout', status: 'requested', price: 12, currency: 'EUR', discount: 2 },
      { id: 2, title: 'Airport pickup', status: 'approved', price: 30, currency: 'EUR', discount: 0 },
    ]),
  ),
]
