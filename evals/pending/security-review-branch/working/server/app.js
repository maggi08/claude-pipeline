const express = require('express')
const cookieParser = require('cookie-parser')
const account = require('./routes/account')
const invoices = require('./routes/invoices')

const app = express()
app.use(express.json())
app.use(cookieParser())
app.use(account)
app.use(invoices)

module.exports = app
