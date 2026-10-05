// Сверка вида новой секции с эталонной — передаётся в evaluate_script целиком, корни секций — в NEW и REF.
// Эталон — соседняя секция того же приложения (строка «Эталон вида» этапа в STAGES.md). Эталон на другой
// странице: сначала прогон там с NEW = null и REF = <его корень>, поле `roles` из ответа — в REFERENCE здесь.
// По ролям (заголовок, кнопка, шапка таблицы, ячейка, подпись, текст) — самый частый вариант в секции:
// шрифт, кегль, вес, межстрочный, регистр, трекинг, у кнопок и шапок таблиц — высота и радиус.
// Расхождение — не вердикт, но каждое идёт строкой в отчёт: без решения пользователя «вид как в прототипе» это находка.
// Откуда: вид взяли из прототипа (uppercase 11px extrabold, кнопки 36px bold, таблица своего вида) — прототип
// совпадал с кодом, а «жирно» и «разные кнопки» пользователь увидел рядом с остальным дашбордом.
() => {
  const NEW = 'main section:last-of-type' // ← корень новой или изменённой секции этапа
  const REF = 'main section:first-of-type' // ← корень эталонной секции на этой странице
  const REFERENCE = null // ← поле `roles` прогона на странице эталона, если эталон там
  const ROLES = {
    heading: 'h1, h2, h3, h4, h5, h6, [role="heading"]',
    button: 'button, [role="button"], a[class*="button" i], a[class*="btn" i]',
    'table-head': 'th, [role="columnheader"]',
    cell: 'td, [role="cell"], [role="gridcell"]',
    label: 'label, small, [class*="badge" i], [class*="pill" i], [class*="chip" i], [class*="eyebrow" i]',
    text: 'p, li, dd, dt',
  }
  const SIZED = new Set(['button', 'table-head'])
  const visible = (el) => {
    const r = el.getBoundingClientRect()
    const s = getComputedStyle(el)
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && el.textContent.trim()
  }
  const sample = (el, role) => {
    const s = getComputedStyle(el)
    const value = { font: s.fontFamily.split(',')[0].replace(/["']/g, '').trim(), size: s.fontSize, weight: s.fontWeight, line: s.lineHeight, case: s.textTransform, tracking: s.letterSpacing }
    if (SIZED.has(role)) Object.assign(value, { height: `${Math.round(el.getBoundingClientRect().height)}px`, radius: s.borderTopLeftRadius })
    return value
  }
  // Самый частый вариант роли: одна выделенная кнопка не подменяет обычные, а число вариантов видно в `variants`.
  const roles = (selector) => {
    const root = selector && document.querySelector(selector)
    if (!root) return null
    const out = {}
    for (const [role, query] of Object.entries(ROLES)) {
      const variants = new Map()
      for (const el of root.querySelectorAll(query)) {
        if (!visible(el)) continue
        const value = sample(el, role)
        const key = JSON.stringify(value)
        const seen = variants.get(key)
        variants.set(key, { value, count: (seen?.count ?? 0) + 1, example: seen?.example ?? el.textContent.trim().slice(0, 24) })
      }
      const ranked = [...variants.values()].sort((a, b) => b.count - a.count)
      if (ranked.length) out[role] = { ...ranked[0].value, n: ranked.reduce((sum, { count }) => sum + count, 0), variants: ranked.length, example: ranked[0].example }
    }
    return out
  }
  const mine = roles(NEW)
  const theirs = REFERENCE ?? roles(REF)
  if (!mine || !theirs) return { roles: mine ?? theirs, missing: [!mine && NEW, !theirs && REF].filter(Boolean) }
  const KEYS = ['font', 'size', 'weight', 'line', 'case', 'tracking', 'height', 'radius']
  const shared = Object.keys(mine).filter((role) => theirs[role])
  const diff = shared
    .map((role) => {
      const keys = KEYS.filter((key) => key in mine[role] && key in theirs[role] && mine[role][key] !== theirs[role][key])
      return keys.length ? { role, ...Object.fromEntries(keys.map((key) => [key, `${theirs[role][key]} → ${mine[role][key]}`])), example: mine[role].example } : null
    })
    .filter(Boolean)
  return { roles: mine, diff, unmatched: Object.keys(mine).filter((role) => !theirs[role]), summary: `roles ${shared.length} · differ ${diff.length}` }
}
