import { Redirect, Route, Switch, useHistory } from 'react-router-dom'
import { useAuth } from './auth'

export function App() {
  const { user } = useAuth()
  const history = useHistory()
  return (
    <Switch>
      <Route path="/dashboard">{user ? <Dashboard onLogout={() => history.push('/login')} /> : <Redirect to="/login" />}</Route>
    </Switch>
  )
}
