export function showToast(message: string): void {
  window.dispatchEvent(new CustomEvent('toast', { detail: message }))
}
