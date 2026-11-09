# billing-portal
Express API in `server/`, React SPA in `web/`. `requireUser` (server/auth.js) reads the session cookie and sets `req.user`; every `/api` route of a signed-in user goes through it. A company's invoices are shared by its members.
