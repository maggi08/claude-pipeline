// Sends the browser on to a page of this site; anything that is not a local path goes home.
function redirectInternal(res, target) {
  const path = String(target ?? '')
  if (!path || path.includes('://')) return res.redirect(302, '/')
  res.redirect(302, path)
}

module.exports = { redirectInternal }
