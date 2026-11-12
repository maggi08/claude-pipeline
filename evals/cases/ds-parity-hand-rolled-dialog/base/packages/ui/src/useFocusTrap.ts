import { useEffect, type RefObject } from 'react'

const FOCUSABLE = 'a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])'

/** Keeps Tab inside the element while active, focuses its first control, and gives focus back to the opener on release. */
export function useFocusTrap(ref: RefObject<HTMLElement>, active: boolean) {
  useEffect(() => {
    if (!active || !ref.current) return
    const opener = document.activeElement as HTMLElement | null
    const nodes = () => Array.from(ref.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])
    nodes()[0]?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return
      const list = nodes()
      const first = list[0]
      const last = list[list.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last?.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first?.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      opener?.focus()
    }
  }, [ref, active])
}
