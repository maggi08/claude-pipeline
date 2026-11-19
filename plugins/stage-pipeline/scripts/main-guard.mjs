import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * Whether the module of `metaUrl` is the script node was started with. Node resolves symlinks in the path of the main module, `process.argv[1]` keeps them,
 * so a plugin under a symlinked path (macOS `/var` → `/private/var`) failed the plain `import.meta.url === pathToFileURL(argv[1])` test and the script exited 0
 * without output (VT-13 stage 6). Both sides are compared as real paths; a path that cannot be resolved is not the entry.
 */
export function isMain(metaUrl) {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(metaUrl))
  } catch {
    return false
  }
}
