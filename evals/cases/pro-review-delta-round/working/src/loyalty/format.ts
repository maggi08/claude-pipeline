import { type Locale, t } from '../i18n'

/** The points label next to prices and in the balance line. */
export function formatPoints(count: number, locale: Locale = 'en'): string {
  return t(locale, 'loyalty.points', { count: count.toLocaleString(locale) })
}
