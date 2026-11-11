import type { ButtonHTMLAttributes } from 'react'

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
  size?: 'sm' | 'md'
}

export function Button({ variant = 'primary', size = 'md', className = '', ...rest }: ButtonProps) {
  return <button className={`fui-button fui-button--${variant} fui-button--${size} ${className}`.trim()} {...rest} />
}
