/** The hook's stdin as an object ({} when it is empty or not JSON). Kept apart from pipeline-state.mjs so a hook can read its input before it loads anything else. */
export async function readHookInput() {
  let raw = ''
  for await (const chunk of process.stdin) raw += chunk
  try {
    return JSON.parse(raw)
  } catch {
    return {}
  }
}
