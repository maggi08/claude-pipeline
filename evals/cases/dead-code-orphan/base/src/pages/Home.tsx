import { t } from '../i18n'
import { OldBanner } from '../components/OldBanner'
export function Home() {
  return (
    <main>
      <h1>{t('home.title')}</h1>
      <OldBanner />
    </main>
  )
}
