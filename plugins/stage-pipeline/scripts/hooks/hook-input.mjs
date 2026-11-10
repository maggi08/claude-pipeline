/**
 * The hook's stdin as an object ({} when it is empty or not JSON). Kept apart from pipeline-state.mjs so a hook can read its input before it loads anything else.
 * It also makes stdout blocking: on macOS a pipe is written asynchronously, so a verdict over 64 KiB followed by `process.exit` was cut and Claude Code got invalid JSON.
 */
export async function readHookInput() {
  process.stdout._handle?.setBlocking?.(true)
  let raw = ''
  for await (const chunk of process.stdin) raw += chunk
  try {
    return JSON.parse(raw)
  } catch {
    return {}
  }
}
