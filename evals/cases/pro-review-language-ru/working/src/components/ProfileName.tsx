import { t } from '../i18n'
export function ProfileName({ name }: { name: string | null }) {
  return <span>{name?.trim() ? name : t('profile.anonymous')}</span>
}
