import { useEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useFocusTrap } from './useFocusTrap'
import './dialog.css'

export type DialogProps = {
  open: boolean
  title: string
  onClose: () => void
  children: ReactNode
  /** The footer buttons, right-aligned. */
  actions?: ReactNode
  tone?: 'default' | 'danger'
}

/** A modal dialog: rendered into document.body, traps focus, closes on Escape and on the backdrop, gives focus back on close. */
export function Dialog({ open, title, onClose, children, actions, tone = 'default' }: DialogProps) {
  const panel = useRef<HTMLDivElement>(null)
  useFocusTrap(panel, open)
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose()
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])
  if (!open) return null
  return createPortal(
    <div className="fui-backdrop" onClick={onClose}>
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby="fui-dialog-title"
        className={`fui-dialog fui-dialog--${tone}`}
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id="fui-dialog-title" className="fui-dialog__title">
          {title}
        </h2>
        <div className="fui-dialog__body">{children}</div>
        {actions && <div className="fui-dialog__actions">{actions}</div>}
      </div>
    </div>,
    document.body,
  )
}
