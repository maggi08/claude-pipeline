// Замер геометрии новых узлов этапа — передаётся в evaluate_script целиком, селекторы — в SELECTORS.
// Возвращает компактный JSON: переполнение, нулевой зазор до края ближайшего «видимого» контейнера
// (фон, рамка, тень, обрезка), обрезку окном или предком, тексты в 3+ строки, текущий фокус.
// Флаг — не вердикт: сверь его с макетом и решениями этапа, но каждый флаг попадает в отчёт.
// Откуда: плашка схлопнула `m-4` на дне меню (зазор 0), чекер мерил ширину и вложенность;
// название страны в 3 строки вылезало из карточки на скриншотах самого чекера.
() => {
  const SELECTORS = ['main'] // ← селекторы новых или изменённых узлов этапа
  const round = (n) => Math.round(n * 10) / 10
  const box = (r) => [round(r.left), round(r.top), round(r.width), round(r.height)]
  const transparent = (c) => !c || c === 'transparent' || /rgba\([^)]*,\s*0\)$/.test(c)
  const painted = (el) => {
    const s = getComputedStyle(el)
    const border = ['Top', 'Right', 'Bottom', 'Left'].some((side) => parseFloat(s[`border${side}Width`]) > 0 && !transparent(s[`border${side}Color`]))
    return !transparent(s.backgroundColor) || border || s.boxShadow !== 'none' || /hidden|clip|auto|scroll/.test(s.overflow)
  }
  // Внутренний край (без рамки) ближайшего видимого предка; нет такого — окно.
  const edgeOf = (el) => {
    const r = el.getBoundingClientRect()
    const s = getComputedStyle(el)
    return { name: `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}`, top: r.top + parseFloat(s.borderTopWidth), right: r.right - parseFloat(s.borderRightWidth), bottom: r.bottom - parseFloat(s.borderBottomWidth), left: r.left + parseFloat(s.borderLeftWidth) }
  }
  const container = (el) => {
    for (let node = el.parentElement; node && node !== document.body; node = node.parentElement) if (painted(node)) return edgeOf(node)
    return { name: 'viewport', top: -scrollY, left: -scrollX, right: document.documentElement.clientWidth, bottom: Math.max(innerHeight, document.documentElement.scrollHeight - scrollY) }
  }
  const textRange = (el) => {
    const range = document.createRange()
    range.selectNodeContents(el)
    return range
  }
  const lines = (range) => new Set([...range.getClientRects()].filter((r) => r.width > 0).map((r) => Math.round(r.top))).size
  const out = { viewport: [innerWidth, innerHeight], focus: null, nodes: [], overflow: [], wrap: [] }
  const active = document.activeElement
  if (active && active !== document.body) {
    out.focus = { tag: active.tagName.toLowerCase(), role: active.getAttribute('role'), focusVisible: active.matches(':focus-visible'), outline: getComputedStyle(active).outlineStyle }
  }
  const seen = new Set()
  for (const selector of SELECTORS) {
    ;[...document.querySelectorAll(selector)].slice(0, 5).forEach((el, index) => {
      const r = el.getBoundingClientRect()
      if (!r.width && !r.height) return
      const edge = container(el)
      const gap = { t: round(r.top - edge.top), r: round(edge.right - r.right), b: round(edge.bottom - r.bottom), l: round(r.left - edge.left) }
      const node = { sel: selector, i: index, box: box(r), container: edge.name, gap }
      const zero = Object.entries(gap).filter(([, value]) => Math.abs(value) < 0.5).map(([side]) => side)
      const outside = Object.entries(gap).filter(([, value]) => value <= -0.5).map(([side]) => side)
      if (zero.length) node.zeroGap = zero
      if (outside.length) node.outside = outside
      const clipped = []
      if (r.top < 0 || r.left < 0 || r.bottom > innerHeight || r.right > innerWidth) clipped.push('viewport')
      for (let a = el.parentElement; a && a !== document.documentElement; a = a.parentElement) {
        if (!/hidden|clip/.test(getComputedStyle(a).overflow)) continue
        const ar = a.getBoundingClientRect()
        if (r.top < ar.top - 0.5 || r.bottom > ar.bottom + 0.5 || r.left < ar.left - 0.5 || r.right > ar.right + 0.5) clipped.push(a.tagName.toLowerCase())
        break
      }
      if (clipped.length) node.clipped = clipped
      out.nodes.push(node)
      for (const child of [el, ...el.querySelectorAll('*')]) {
        if (seen.has(child)) continue
        seen.add(child)
        const s = getComputedStyle(child)
        if (child.scrollWidth > child.clientWidth + 1 && child.clientWidth && !/auto|scroll/.test(s.overflowX)) {
          out.overflow.push({ in: selector, tag: child.tagName.toLowerCase(), text: (child.innerText || '').trim().slice(0, 40), scroll: child.scrollWidth, client: child.clientWidth })
        }
        if (![...child.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue
        // Текст меряется своими границами против своего видимого бокса: у карточки — её же край.
        const range = textRange(child)
        const tr = range.getBoundingClientRect()
        const host = painted(child) ? edgeOf(child) : container(child)
        const past = { r: round(tr.right - host.right), b: round(tr.bottom - host.bottom) }
        if (past.r > 0.5 || past.b > 0.5) out.overflow.push({ in: selector, tag: child.tagName.toLowerCase(), text: child.innerText.trim().slice(0, 40), past })
        const count = lines(range)
        if (count >= 3) out.wrap.push({ in: selector, text: child.innerText.trim().slice(0, 40), lines: count, width: round(tr.width) })
      }
    })
  }
  out.overflow = out.overflow.slice(0, 12)
  out.wrap = out.wrap.slice(0, 8)
  out.summary = `overflow ${out.overflow.length} · zero-gap ${out.nodes.filter((n) => n.zeroGap).length} · clipped ${out.nodes.filter((n) => n.clipped).length}`
  return out
}
