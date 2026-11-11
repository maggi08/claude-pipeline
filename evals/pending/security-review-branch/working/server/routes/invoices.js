const express = require('express')
const { requireUser } = require('../auth')
const db = require('../db')

const router = express.Router()

const READERS = new Set(['admin', 'viewer'])

router.get('/api/invoices', requireUser, (req, res) => {
  res.json(db.invoices.filter((invoice) => invoice.companyId === req.user.companyId))
})

router.get('/api/invoices/:id', requireUser, (req, res) => {
  if (!READERS.has(req.user.role)) return res.status(403).json({ error: 'forbidden' })
  const invoice = db.invoices.find((item) => item.id === req.params.id)
  if (!invoice) return res.status(404).json({ error: 'not found' })
  res.json(invoice)
})

router.post('/api/invoices/:id/comments', requireUser, (req, res) => {
  const invoice = db.invoices.find((item) => item.id === req.params.id && item.companyId === req.user.companyId)
  if (!invoice) return res.status(404).json({ error: 'not found' })
  const comment = { id: `c-${Date.now()}`, author: req.user.email, body: String(req.body.body ?? '').slice(0, 2000) }
  invoice.comments.push(comment)
  res.status(201).json(comment)
})

module.exports = router
