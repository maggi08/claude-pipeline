const express = require('express')
const { requireUser } = require('../auth')
const db = require('../db')

const router = express.Router()

router.get('/api/account/payment-methods', requireUser, (req, res) => {
  res.json(db.paymentMethods.filter((method) => method.companyId === req.user.companyId))
})

module.exports = router
