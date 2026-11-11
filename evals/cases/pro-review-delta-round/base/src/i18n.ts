import en from '../locales/en.json'
import ru from '../locales/ru.json'

const catalogs = { en, ru }

export type Locale = keyof typeof catalogs
export type MessageKey = keyof typeof en

export function t(locale: Locale, key: MessageKey, params: Record<string, string | number> = {}): string {
  return catalogs[locale][key].replace(/\{(\w+)\}/g, (_, name: string) => String(params[name]))
}
