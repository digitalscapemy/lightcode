import type { LayoutNode, SplitNode } from '../../shared/types'
import { persist } from './store'

const MIN_SIZE = 0.1

/**
 * Render a tab's layout tree into its view element. Pane elements are owned
 * by their TerminalPane and are re-appended (reparented) — never recreated —
 * so terminal state survives every layout change.
 */
export function renderLayout(
  container: HTMLElement,
  layout: LayoutNode,
  paneEl: (id: string) => HTMLElement
): void {
  container.textContent = ''
  container.appendChild(buildNode(layout, paneEl))
}

function buildNode(node: LayoutNode, paneEl: (id: string) => HTMLElement): HTMLElement {
  if (node.type === 'pane') return paneEl(node.id)

  const split = document.createElement('div')
  split.className = 'split'
  split.style.flexDirection = node.orientation
  node.children.forEach((child, i) => {
    const wrap = document.createElement('div')
    wrap.className = 'split-child'
    wrap.style.flex = `${node.sizes[i]} 1 0px`
    wrap.appendChild(buildNode(child, paneEl))
    split.appendChild(wrap)
    if (i < node.children.length - 1) {
      split.appendChild(makeGutter(node, i, split))
    }
  })
  return split
}

function makeGutter(node: SplitNode, index: number, splitEl: HTMLElement): HTMLElement {
  const gutter = document.createElement('div')
  gutter.className = 'gutter ' + (node.orientation === 'row' ? 'gutter-h' : 'gutter-v')

  gutter.addEventListener('pointerdown', (e) => {
    e.preventDefault()
    gutter.setPointerCapture(e.pointerId)
    const horizontal = node.orientation === 'row'
    const total = horizontal ? splitEl.clientWidth : splitEl.clientHeight
    const start = horizontal ? e.clientX : e.clientY
    const s0 = node.sizes[index]
    const s1 = node.sizes[index + 1]
    const wraps = Array.from(splitEl.children).filter((c) =>
      c.classList.contains('split-child')
    ) as HTMLElement[]

    const onMove = (ev: PointerEvent): void => {
      if (total <= 0) return
      const delta = ((horizontal ? ev.clientX : ev.clientY) - start) / total
      let a = s0 + delta
      let b = s1 - delta
      if (a < MIN_SIZE) {
        b -= MIN_SIZE - a
        a = MIN_SIZE
      }
      if (b < MIN_SIZE) {
        a -= MIN_SIZE - b
        b = MIN_SIZE
      }
      node.sizes[index] = a
      node.sizes[index + 1] = b
      wraps[index].style.flex = `${a} 1 0px`
      wraps[index + 1].style.flex = `${b} 1 0px`
    }
    const onUp = (): void => {
      gutter.removeEventListener('pointermove', onMove)
      gutter.removeEventListener('pointerup', onUp)
      persist()
    }
    gutter.addEventListener('pointermove', onMove)
    gutter.addEventListener('pointerup', onUp)
  })

  return gutter
}
