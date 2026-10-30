import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { usePortalContainer } from './portal'

type Props = { open: boolean; title: string; onClose: () => void; container?: HTMLElement; children: ReactNode }

export function Dialog({ open, title, onClose, container, children }: Props) {
  const provided = usePortalContainer()
  if (!open) return null
  return createPortal(
    <div role="dialog" aria-label={title}>
      <button aria-label="close" onClick={onClose} />
      {children}
    </div>,
    container ?? provided,
  )
}
