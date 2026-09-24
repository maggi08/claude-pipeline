import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, isAbsolute } from 'node:path'

/**
 * Общее состояние пайплайна для хуков. Плагин включён во всех репозиториях,
 * поэтому всё, что не находит `.claude/pipeline.config.md`, возвращает null —
 * хук в чужом репо обязан молчать.
 */
export function readPipelineState(cwd) {
  const root = repoRoot(cwd)
  const configPath = join(root, '.claude/pipeline.config.md')
  if (!existsSync(configPath)) return null

  const config = readFileSync(configPath, 'utf8')
  const taskPath = config.match(/^\s*-\s*task_path:\s*([^\s#]+)/m)?.[1] ?? '.claude/tasks/'
  const taskDir = isAbsolute(taskPath) ? taskPath : join(root, taskPath)
  if (!existsSync(taskDir)) return { root, taskDir, tasks: [] }

  const tasks = readdirSync(taskDir)
    .map((ticket) => ({ ticket, dir: join(taskDir, ticket) }))
    .filter(({ dir }) => statSync(dir).isDirectory() && existsSync(join(dir, 'STAGES.md')))
    .map(({ ticket, dir }) => {
      const stagesPath = join(dir, 'STAGES.md')
      const stages = readFileSync(stagesPath, 'utf8')
      return {
        ticket,
        stagesPath,
        mtime: statSync(stagesPath).mtimeMs,
        sizeKb: Math.round(statSync(stagesPath).size / 1024),
        status: stages.match(/^## Статус:\s*(.+)$/m)?.[1]?.trim() ?? null,
        inProgress: /\[status:\s*in-progress\]/.test(stages),
        open: /\[status:\s*(todo|in-progress)\]/.test(stages),
        // Тот же признак force-режима, что в /stage-check, Шаг 4.4: блок «Force-прогон» в STAGES.md.
        forceActive: /^## Force-прогон/m.test(stages),
      }
    })
    .sort((a, b) => b.mtime - a.mtime)

  return { root, taskDir, tasks }
}

function repoRoot(cwd) {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return cwd
  }
}

export async function readHookInput() {
  let raw = ''
  for await (const chunk of process.stdin) raw += chunk
  try {
    return JSON.parse(raw)
  } catch {
    return {}
  }
}
