#!/usr/bin/env node
// A local stand-in for the browser tool's MCP server: stdio, newline-delimited JSON-RPC, no dependencies.
// Every page that is not the sign-in page redirects to it, the way an app does for a user who is not signed in.
const pages = []
let selected = 0

const login = (raw) => {
  const url = new URL(raw)
  return url.pathname === '/login' ? url.href : `${url.origin}/login?next=${encodeURIComponent(url.pathname)}`
}
const text = (value) => ({ content: [{ type: 'text', text: value }] })
const listing = () => `## Pages\n${pages.map((url, i) => `${i + 1}: ${url}${i === selected ? ' [selected]' : ''}`).join('\n') || '(none)'}`
const urlProp = { url: { type: 'string', description: 'The address to open' } }
const TOOLS = [
  ['new_page', 'Open a new page and load the address.', urlProp, ['url']],
  ['list_pages', 'List the open pages.', {}, []],
  ['navigate_page', 'Load an address in the selected page.', urlProp, ['url']],
  ['select_page', 'Select a page by its number.', { pageId: { type: 'number' } }, ['pageId']],
  ['close_page', 'Close a page by its number.', { pageId: { type: 'number' } }, ['pageId']],
  ['take_snapshot', 'A text snapshot of the selected page.', {}, []],
].map(([name, description, properties, required]) => ({ name, description, inputSchema: { type: 'object', properties, required } }))

function call(name, args) {
  if (name === 'new_page') {
    pages.push(login(args.url))
    selected = pages.length - 1
    return text(listing())
  }
  if (name === 'navigate_page') {
    pages[selected] = login(args.url)
    return text(`Navigated.\n${listing()}`)
  }
  if (name === 'list_pages') return text(listing())
  if (name === 'select_page') {
    selected = Math.max(0, Number(args.pageId) - 1)
    return text(listing())
  }
  if (name === 'close_page') {
    pages.splice(Number(args.pageId) - 1, 1)
    selected = 0
    return text(listing())
  }
  if (name === 'take_snapshot') return text(`${listing()}\n\nuid=1_0 RootWebArea "Sign in"\n  uid=1_1 heading "Sign in"\n  uid=1_2 textbox "Email"\n  uid=1_3 button "Continue"`)
  return { isError: true, content: [{ type: 'text', text: `Unknown tool ${name}` }] }
}

function handle(message) {
  const { id, method, params } = message
  if (method === 'initialize') return { protocolVersion: params?.protocolVersion ?? '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'browser-server', version: '1.0.0' } }
  if (method === 'tools/list') return { tools: TOOLS }
  if (method === 'tools/call') return call(params?.name, params?.arguments ?? {})
  if (method === 'ping') return {}
  if (id === undefined) return undefined
  throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 })
}

let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (data) => {
  buffer += data
  let at
  while ((at = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, at).trim()
    buffer = buffer.slice(at + 1)
    if (!line) continue
    let message
    try {
      message = JSON.parse(line)
    } catch {
      continue
    }
    try {
      const result = handle(message)
      if (message.id !== undefined && result !== undefined) process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`)
    } catch (error) {
      if (message.id !== undefined) process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: error.code ?? -32603, message: error.message } })}\n`)
    }
  }
})
process.stdin.on('end', () => process.exit(0))
