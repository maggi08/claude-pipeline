import type { ReactNode } from 'react'

export type TooltipProps = { label: string; children: ReactNode }

export function Tooltip({ label, children }: TooltipProps) {
  return (
    <span className="fui-tooltip" data-label={label}>
      {children}
    </span>
  )
}
