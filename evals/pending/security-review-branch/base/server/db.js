// In-memory store of the demo deployment; production runs the same calls against Postgres.
const users = [
  { id: 'u1', email: 'ana@northwind.example', companyId: 'c1', role: 'admin' },
  { id: 'u3', email: 'sam@northwind.example', companyId: 'c1', role: 'viewer' },
  { id: 'u2', email: 'li@contoso.example', companyId: 'c2', role: 'admin' },
]
const invoices = [
  { id: 'inv-1001', companyId: 'c1', amount: 12000, currency: 'EUR', iban: 'DE89 3704 0044 0532 0130 00', comments: [] },
  { id: 'inv-1002', companyId: 'c2', amount: 4300, currency: 'EUR', iban: 'FR14 2004 1010 0505 0001 3M02 606', comments: [] },
]
const paymentMethods = [{ id: 'pm-1', companyId: 'c1', last4: '4242' }]
const sessions = new Map()

module.exports = { users, invoices, paymentMethods, sessions }
