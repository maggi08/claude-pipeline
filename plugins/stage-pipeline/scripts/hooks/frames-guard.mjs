import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { readHookInput, readPipelineState } from './pipeline-state.mjs'

/**
 * Рантайм-чекер не заканчивает работу, пока не посмотрел каждый снятый им кадр.
 *
 * Прецедент: финальный прогон снял 12 кадров, агент открыл 2, оркестратор ни одного, а пользователю ушло
 * «12 кадров». Обрезанная плашка — единственный настоящий дефект задачи — была на непросмотренном кадре.
 * На этапе 2 той же задачи агент открыл 5 кадров из 13. В другой задаче название страны в три строки
 * вылезало из карточки на скриншотах самого чекера — их тоже никто не открыл.
 *
 * SubagentStop агента devtools-verify: кадры — `take_screenshot` с `filePath` в его транскрипте и картинки
 * в `checks/` задачи текущей ветки, записанные за время его работы (фолбэк-скрипты puppeteer/playwright
 * пишут их сами). Просмотрен — значит, открыт Read'ом. Непросмотренные — причина продолжить.
 * Петлю Stop-хуков Claude Code обрывает сам (не больше 8 продолжений подряд).
 */
const IMAGE = /\.(png|jpe?g|webp)$/i
const input = await readHookInput()
if (!/devtools-verify$/.test(String(input.agent_type ?? ''))) process.exit(0)
const transcript = input.agent_transcript_path
if (!transcript || !existsSync(transcript)) process.exit(0)

const cwd = input.cwd ?? process.cwd()
let started = Infinity
let ended = -Infinity
const viewed = new Set()
const shot = new Set()
for (const line of readFileSync(transcript, 'utf8').split('\n')) {
  if (!line.trim()) continue
  let record
  try {
    record = JSON.parse(line)
  } catch {
    continue
  }
  const time = Date.parse(record.timestamp ?? '')
  if (Number.isFinite(time)) {
    started = Math.min(started, time)
    ended = Math.max(ended, time)
  }
  const content = record.message?.content
  if (!Array.isArray(content)) continue
  for (const block of content) {
    if (block.type !== 'tool_use') continue
    const name = String(block.name ?? '')
    const file = block.input?.file_path ?? block.input?.filePath
    if (!file) continue
    const path = real(isAbsolute(file) ? file : resolve(cwd, file))
    if (name === 'Read') viewed.add(path)
    else if (/take_screenshot$/.test(name) && IMAGE.test(path)) shot.add(path)
  }
}

const frames = new Set([...shot].filter((path) => existsSync(path)))
const task = readPipelineState(cwd)?.tasks.find((candidate) => candidate.current)
// Окно — время работы агента: кадры соседнего прогона или пользователя ему не принадлежат.
const during = (path) => statSync(path).mtimeMs >= started && statSync(path).mtimeMs <= ended + 60_000
if (task && Number.isFinite(started)) for (const path of images(join(task.dir, 'checks'))) if (during(path)) frames.add(real(path))

const missed = [...frames].filter((path) => !viewed.has(path)).sort()
if (!missed.length) process.exit(0)

const shown = missed.slice(0, 15).map((path) => `- ${path}`)
process.stdout.write(
  JSON.stringify({
    decision: 'block',
    reason:
      `stage-pipeline: ты снял ${frames.size} кадр(ов), а открыл не все — ${missed.length} не просмотрено:\n${shown.join('\n')}${missed.length > 15 ? `\n- … ещё ${missed.length - 15}` : ''}\n` +
      'Открой каждый Read-ом и посмотри глазами: обрезка, наезды, лишние рамки, текст за краем, пустые места. Дефект, найденный на кадре, допиши в отчёт находкой; ' +
      'кадр-артефакт съёмки (кольцо фокуса от синтетического клика, обрезка окном) — переснять, а не пропустить. ' +
      'В одной задаче единственный настоящий дефект задачи был на кадре, который никто не открыл.',
  }),
)
process.exit(0)

// Каталог задач бывает за симлинком (`/var` → `/private/var`, `~/.claude/<team>-tasks`): сравниваются реальные пути.
function real(path) {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

function images(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return images(path)
    return IMAGE.test(entry.name) ? [path] : []
  })
}
