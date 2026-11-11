import type { ReactNode } from 'react'
import './badge.css'

export type BadgeProps = {
  tone?: 'neutral' | 'success' | 'warning' | 'danger' | 'info'
  icon?: ReactNode
  children: ReactNode
}

/** A status label in the theme's tone colors (light and dark). */
export function Badge({ tone = 'neutral', icon, children }: BadgeProps) {
  return (
    <span className={`fui-badge fui-badge--${tone}`}>
      {icon}
      {children}
    </span>
  )
}
