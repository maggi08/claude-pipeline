import en from './i18n/en.json'

const messages: Record<string, string> = en

export const t = (key: string): string => messages[key] ?? key
