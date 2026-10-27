#!/usr/bin/env node
// A local stand-in for the design tool's MCP server: stdio, newline-delimited JSON-RPC, no dependencies.
// Answers initialize, tools/list, tools/call for the nodes in design.json next to this file.
import { readFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const design = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'design.json'), 'utf8'))

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc = (buffer) => {
  let c = 0xffffffff
  for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
const chunk = (type, data) => {
  const body = Buffer.concat([Buffer.from(type), data])
  const out = Buffer.alloc(8 + data.length + 4)
  out.writeUInt32BE(data.length, 0)
  body.copy(out, 4)
  out.writeUInt32BE(crc(body), 8 + data.length)
  return out
}
/** A flat 48x32 PNG in the node's fill colour. */
function png(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: 48 }, () => [r, g, b]).flat())])
  const header = Buffer.alloc(13)
  header.writeUInt32BE(48, 0)
  header.writeUInt32BE(32, 4)
  header.set([8, 2, 0, 0, 0], 8)
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.concat(Array(32).fill(row)))), chunk('IEND', Buffer.alloc(0))])
}

const nodeOf = (id) => design.nodes[String(id ?? '').replace('-', ':')]
const text = (value) => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] })
const missing = (id) => ({ isError: true, content: [{ type: 'text', text: `Node ${id} was not found in file ${design.file}` }] })
const idProp = { nodeId: { type: 'string', description: 'The node id, e.g. 12:34' } }
const TOOLS = [
  ['get_design_context', 'Structure, styles, values and bound variables of a node, as a code-ready description.'],
  ['get_metadata', 'The tree of a node: layer names, ids, sizes and positions.'],
  ['get_variable_defs', 'The variables (tokens) used by a node: colors, spacing, radius, typography.'],
  ['get_screenshot', 'A picture of a node.'],
].map(([name, description]) => ({ name, description, inputSchema: { type: 'object', properties: idProp, required: ['nodeId'] } }))

function call(name, args) {
  const node = nodeOf(args?.nodeId)
  if (!node) return missing(args?.nodeId)
  if (name === 'get_design_context') return text(node.context)
  if (name === 'get_metadata') return text(node.metadata)
  if (name === 'get_variable_defs') return text(node.variables)
  if (name === 'get_screenshot') return { content: [{ type: 'image', data: png(node.fill ?? '#ffffff').toString('base64'), mimeType: 'image/png' }] }
  return { isError: true, content: [{ type: 'text', text: `Unknown tool ${name}` }] }
}

function handle(message) {
  const { id, method, params } = message
  if (method === 'initialize') {
    return { protocolVersion: params?.protocolVersion ?? '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'design-server', version: '1.0.0' } }
  }
  if (method === 'tools/list') return { tools: TOOLS }
  if (method === 'tools/call') return call(params?.name, params?.arguments)
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
