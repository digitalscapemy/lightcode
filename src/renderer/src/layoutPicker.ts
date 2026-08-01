import { activeLayoutId, applyLayout } from './app'
import { LAYOUT_PRESETS, layoutThumbnail } from './layouts'
import type { LayoutPreset } from './layouts'

let menu: HTMLElement | null = null
let dismiss: (() => void) | null = null

export function initLayoutPicker(): void {
  const btn = document.getElementById('layout-btn')!
  btn.addEventListener('click', (e) => {
    e.stopPropagation()
    toggleMenu(btn)
  })
}

export function closeLayoutPicker(): void {
  dismiss?.()
  dismiss = null
  menu?.remove()
  menu = null
}

/** Group presets by pane count, preserving the order they are declared in. */
function groupByCount(): Map<number, LayoutPreset[]> {
  const groups = new Map<number, LayoutPreset[]>()
  for (const preset of LAYOUT_PRESETS) {
    const row = groups.get(preset.count)
    if (row) row.push(preset)
    else groups.set(preset.count, [preset])
  }
  return groups
}

function toggleMenu(anchor: HTMLElement): void {
  if (menu) {
    closeLayoutPicker()
    return
  }
  // Read the current shape once: every option compares against it to show which
  // one the tab is already in.
  const active = activeLayoutId(LAYOUT_PRESETS)

  const el = document.createElement('div')
  el.className = 'layout-menu'
  for (const [count, presets] of groupByCount()) {
    const row = document.createElement('div')
    row.className = 'layout-row'

    const label = document.createElement('span')
    label.className = 'layout-count'
    label.textContent = String(count)
    row.appendChild(label)

    for (const preset of presets) {
      const opt = document.createElement('button')
      opt.className = 'layout-opt' + (preset.id === active ? ' active' : '')
      opt.title = `${count} pane${count === 1 ? '' : 's'}`
      opt.appendChild(layoutThumbnail(preset.spec))
      opt.addEventListener('click', (e) => {
        e.stopPropagation()
        closeLayoutPicker()
        void applyLayout(preset)
      })
      row.appendChild(opt)
    }
    el.appendChild(row)
  }

  document.body.appendChild(el)
  menu = el

  // Anchor under the button, then pull back inside the viewport. The button
  // sits near the right edge, where Windows also parks its caption buttons,
  // so clamping is what keeps the menu on screen on both platforms.
  const a = anchor.getBoundingClientRect()
  el.style.top = `${a.bottom + 4}px`
  el.style.left = `${a.left}px`
  const m = el.getBoundingClientRect()
  if (m.right > window.innerWidth - 8) {
    el.style.left = `${Math.max(8, window.innerWidth - 8 - m.width)}px`
  }

  const onPointerDown = (e: PointerEvent): void => {
    if (!el.contains(e.target as Node) && e.target !== anchor) closeLayoutPicker()
  }
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') closeLayoutPicker()
  }
  window.addEventListener('pointerdown', onPointerDown, true)
  window.addEventListener('keydown', onKey, true)
  window.addEventListener('blur', closeLayoutPicker)
  dismiss = (): void => {
    window.removeEventListener('pointerdown', onPointerDown, true)
    window.removeEventListener('keydown', onKey, true)
    window.removeEventListener('blur', closeLayoutPicker)
  }
}
