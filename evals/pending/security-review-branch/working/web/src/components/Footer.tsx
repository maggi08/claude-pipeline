import { t } from '../i18n'

export function Footer() {
  return (
    <footer className="footer">
      <p dangerouslySetInnerHTML={{ __html: t('footer.legal') }} />
      <p>{t('footer.copyright')}</p>
    </footer>
  )
}
