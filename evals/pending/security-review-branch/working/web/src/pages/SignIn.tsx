import { useState, type FormEvent } from 'react'
import { api } from '../api'
import { t } from '../i18n'
import { safeReturnPath } from '../shared/url'

export function SignIn() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)

  async function submit(event: FormEvent) {
    event.preventDefault()
    try {
      await api('/api/session', { method: 'POST', body: JSON.stringify({ email, password }) })
      const returnTo = new URLSearchParams(window.location.search).get('returnTo')
      window.location.assign(safeReturnPath(returnTo))
    } catch {
      setError(t('signin.error'))
    }
  }

  return (
    <form onSubmit={submit}>
      <h1>{t('signin.title')}</h1>
      <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} />
      <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} />
      {error && <p role="alert">{error}</p>}
      <button type="submit">{t('signin.submit')}</button>
    </form>
  )
}
