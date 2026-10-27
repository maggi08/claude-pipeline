import en from '../locales/en.json'
import ru from '../locales/ru.json'

const dictionaries: Record<string, Record<string, string>> = { en, ru }

export function t(key: string, lang = 'en'): string {
  return dictionaries[lang]?.[key] ?? key
}
