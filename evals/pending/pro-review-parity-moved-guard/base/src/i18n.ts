import en from '../locales/en.json'

const dictionaries: Record<string, Record<string, string>> = { en }

export function t(key: string, lang = 'en'): string {
  return dictionaries[lang]?.[key] ?? key
}
