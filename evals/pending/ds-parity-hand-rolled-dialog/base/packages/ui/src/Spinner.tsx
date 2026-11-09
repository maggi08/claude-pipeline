import './spinner.css'

export type SpinnerProps = {
  size?: 'sm' | 'md' | 'lg'
  /** Read by screen readers; the visual has no text. */
  label?: string
}

/** A loading indicator: announced as a status, still under prefers-reduced-motion, in the theme's accent color. */
export function Spinner({ size = 'md', label = 'Loading' }: SpinnerProps) {
  return (
    <span role="status" aria-live="polite" className={`fui-spinner fui-spinner--${size}`}>
      <span className="fui-visually-hidden">{label}</span>
    </span>
  )
}
