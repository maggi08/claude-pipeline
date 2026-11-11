/** A comment keeps the line breaks and links people paste; script tags are cut out before it is shown. */
export function formatComment(body: string): string {
  return body.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/\n/g, '<br>')
}
