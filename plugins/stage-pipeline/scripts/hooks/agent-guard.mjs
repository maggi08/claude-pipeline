import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openForceBlock, readHookInput, readPipelineState, reviewModel } from './pipeline-state.mjs'

/**
 * Два правила запуска субагентов, которые оркестратор держит только в памяти — и на длинном
 * прогоне теряет:
 *
 * - whole-branch pro-review идёт на `review_model` (stage-check, Шаг 3.3). Модель передаётся
 *   параметром при вызове, и из 13 живых whole-branch ревью 5 ушли на sonnet из frontmatter
 *   агента: первое ревью прогона — на opus, второе, по соседней ветке или после догона, — уже нет.
 * - `stage-implement` стартует только после одного подтверждения прогона (stage-force, Шаг 0):
 *   оркестратор показывает, как понял ответы интервью, допущения и границы, и пишет в блок
 *   «Force-прогон» строку `Подтверждено:`. Без неё свободный ответ «текущая ветка» тихо
 *   превращался в ветку от release вместо dev, а «вернуть в webview» — в «master не трогать».
 *   Блоки, открытые до 0.12 (дата в заголовке раньше CONFIRM_SINCE), хук не трогает: идущий прогон
 *   не обязан переписывать свой блок, даже открытый в день релиза ещё на 0.11.
 */
const CONFIRM_SINCE = '2026-10-03'
const CONFIRMED = /^\s*[-*]?\s*\**Подтвержд[её]н[оа]?\**\s*:/im
const WHOLE_BRANCH = /whole[-\s]branch\s+mode|(?:режим|mode)\s*:?\s*\**whole[-\s]branch/i

const input = await readHookInput()
const toolInput = input.tool_input ?? {}
const type = String(toolInput.subagent_type ?? '')
const agent = type.split(':').at(-1)
if (agent !== 'pro-review' && agent !== 'stage-implement') process.exit(0)

const state = readPipelineState(input.cwd ?? process.cwd())
if (!state) process.exit(0)

if (agent === 'pro-review' && WHOLE_BRANCH.test(toolInput.prompt ?? '')) {
  const want = reviewModel(state.config)
  const got = String(toolInput.model || agentModel('pro-review')).toLowerCase()
  if (!got.includes(want) && !want.includes(got)) {
    deny(
      `stage-pipeline: whole-branch pro-review идёт на review_model — \`${want}\` (pipeline.config.md, по умолчанию opus), а вызов уходит на \`${got}\`. ` +
        `Повтори тот же вызов с model: "${want}" (stage-check, Шаг 3.3).`,
    )
  }
}

if (agent === 'stage-implement') {
  const task = state.tasks.find((candidate) => candidate.current)
  const block = task && openForceBlock(task.stages)
  if (block && block.date && block.date >= CONFIRM_SINCE && !CONFIRMED.test(block.body)) {
    deny(
      `stage-pipeline: в блоке «${block.heading.replace(/^## /, '')}» задачи ${task.ticket} нет строки подтверждения прогона (stage-force, Шаг 0). ` +
        'Покажи пользователю одним сообщением ответы интервью — каждый ответ свободным текстом эхом «понял „…“ как …», — допущения и границы и возьми одно «да». ' +
        'Затем допиши в блок строку `Подтверждено: <дата> — <ответ пользователя>` и повтори запуск. Пользователь заранее сказал не спрашивать — так и запиши его словами.',
    )
  }
}
process.exit(0)

function agentModel(name) {
  try {
    const file = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../agents', `${name}.md`), 'utf8')
    return file.match(/^model:\s*(\S+)/m)?.[1] ?? 'inherit'
  } catch {
    return 'inherit'
  }
}

function deny(reason) {
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }),
  )
  process.exit(0)
}
