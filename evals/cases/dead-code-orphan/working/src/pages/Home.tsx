import { t } from '../i18n'
import { PromoBanner } from '../components/PromoBanner'
export function Home() {
  return (
    <main>
      <h1>{t('home.title')}</h1>
      <PromoBanner />
    </main>
  )
}
