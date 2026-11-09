const { sessions } = require('./db')

// Sets req.user from the session cookie; answers 401 without a session.
function requireUser(req, res, next) {
  const sid = req.cookies?.sid
  const user = sid && sessions.get(sid)
  if (!user) return res.status(401).json({ error: 'unauthorized' })
  req.user = user
  next()
}

module.exports = { requireUser }
