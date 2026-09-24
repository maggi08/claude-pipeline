import en from '../locales/en.json'
export const t = (key: keyof typeof en): string => en[key]
