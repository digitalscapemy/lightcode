/**
 * One tooltip for every button that has a `data-tip`.
 *
 * Native `title` tooltips are slow, unstyled and cannot show a shortcut as a
 * key. These are delegated from the document, so any element — toolbar button,
 * pane-header icon, built now or later — gets one by setting attributes:
 *
 *   data-tip       the name ("Fan-out")
 *   data-tip-desc  one line on what it does (optional)
 *   data-tip-key   its shortcut, e.g. "Ctrl+Shift+F" (optional)
 *
 * Text only (textContent), never markup, and nothing at all while a pointer
 * button is held or a drag is in progress.
 */

const SHOW_DELAY_MS = 450

let tip: HTMLElement | null = null
let showTimer: number | null = null
let current: HTMLElement | null = null

function ensureTip(): HTMLElement {
  if (tip && tip.isConnected) return tip
  tip = document.createElement('div')
  tip.className = 'ui-tooltip'
  tip.setAttribute('role', 'tooltip')
  document.body.appendChild(tip)
  return tip
}

function hide(): void {
  if (showTimer !== null) window.clearTimeout(showTimer)
  showTimer = null
  current = null
  tip?.classList.remove('visible')
}

function show(target: HTMLElement): void {
  const t = ensureTip()
  t.replaceChildren()
  const name = document.createElement('div')
  name.className = 'ui-tooltip-name'
  name.textContent = target.dataset['tip'] ?? ''
  const key = target.dataset['tipKey']
  if (key) {
    const k = document.createElement('span')
    k.className = 'kbd'
    k.textContent = key
    name.appendChild(k)
  }
  t.appendChild(name)
  const desc = target.dataset['tipDesc']
  if (desc) {
    const d = document.createElement('div')
    d.className = 'ui-tooltip-desc'
    d.textContent = desc
    t.appendChild(d)
  }

  // Below the target, centred, kept inside the window.
  t.classList.add('visible')
  const r = target.getBoundingClientRect()
  const w = t.offsetWidth
  const h = t.offsetHeight
  let left = r.left + r.width / 2 - w / 2
  left = Math.max(8, Math.min(left, window.innerWidth - w - 8))
  let top = r.bottom + 6
  if (top + h > window.innerHeight - 8) top = r.top - h - 6
  t.style.left = `${left}px`
  t.style.top = `${top}px`
}

export function initTooltips(): void {
  document.addEventListener('pointerover', (e) => {
    const target = (e.target as Element | null)?.closest<HTMLElement>('[data-tip]')
    if (target === current) return
    hide()
    if (!target || e.buttons !== 0 || document.body.classList.contains('tab-dragging')) return
    current = target
    showTimer = window.setTimeout(() => {
      if (current === target && target.isConnected) show(target)
    }, SHOW_DELAY_MS)
  })
  document.addEventListener('pointerdown', hide, true)
  document.addEventListener('keydown', hide, true)
  window.addEventListener('blur', hide)
  document.addEventListener('scroll', hide, true)
}
