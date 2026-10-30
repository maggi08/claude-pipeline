import { useState } from 'react'

type Props = { label: string; confirmLabel: string; onConfirm: () => Promise<void> }

export function ConfirmButton({ label, confirmLabel, onConfirm }: Props) {
  const [armed, setArmed] = useState(false)
  const [running, setRunning] = useState(false)
  async function handleClick() {
    if (!armed) return setArmed(true)
    setRunning(true)
    try {
      await onConfirm()
    } finally {
      setRunning(false)
      setArmed(false)
    }
  }
  return (
    <button disabled={running} onClick={handleClick}>
      {armed ? confirmLabel : label}
    </button>
  )
}
