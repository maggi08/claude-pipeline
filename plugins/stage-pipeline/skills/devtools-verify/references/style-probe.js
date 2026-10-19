// Comparing the look of a new section with the reference one — passed to evaluate_script whole, the section roots go in NEW and REF.
// The reference is a neighbouring section of the same app (the "Visual reference" line of the stage in STAGES.md). A reference on another
// page: first run there with NEW = null and REF = <its root>, and put the `roles` field of the answer into REFERENCE here.
// By roles (heading, button, table header, cell, caption, text) — the most frequent variant in the section:
// font, size, weight, line height, case, tracking, and for buttons and table headers — height and radius.
// A difference is not a verdict, but each one goes into the report as a line: without a user decision "the look as in the prototype" it is a finding.
// Origin: the look was taken from a prototype (uppercase 11px extrabold, 36px bold buttons, a table with its own look) — the prototype
// matched the code, and "too bold" and "different buttons" the user saw next to the rest of the dashboard.
() => {
  const NEW = 'main section:last-of-type' // ← the root of the stage's new or changed section
  const REF = 'main section:first-of-type' // ← the root of the reference section on this page
  const REFERENCE = null // ← the `roles` field of the run on the reference page, if the reference is there
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
  // The most frequent variant of a role: one highlighted button does not replace ordinary ones, and the number of variants is visible in `variants`.
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
