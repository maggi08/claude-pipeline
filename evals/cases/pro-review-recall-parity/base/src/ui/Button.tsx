import type { ReactNode } from 'react'

type Props = { onClick: () => void; loading?: boolean; children: ReactNode }

export function Button({ onClick, loading = false, children }: Props) {
  return (
    <button onClick={onClick} disabled={loading} aria-busy={loading}>
      {children}
    </button>
  )
}
