import { Button, type ButtonProps } from '@fleet/ui'

/** The compact ghost button of page toolbars. */
export function ToolbarButton(props: Omit<ButtonProps, 'size' | 'variant'>) {
  return <Button size="sm" variant="ghost" {...props} />
}
