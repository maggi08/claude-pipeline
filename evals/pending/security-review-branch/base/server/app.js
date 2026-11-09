const express = require('express')
const cookieParser = require('cookie-parser')
const account = require('./routes/account')

const app = express()
app.use(express.json())
app.use(cookieParser())
app.use(account)

module.exports = app
