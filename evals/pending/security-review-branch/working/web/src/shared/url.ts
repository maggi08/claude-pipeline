/** The path to go back to after sign-in: only a page of this site, anything else goes home. */
export function safeReturnPath(raw: string | null): string {
  if (!raw) return '/'
  return raw.startsWith('/') ? raw : '/'
}
