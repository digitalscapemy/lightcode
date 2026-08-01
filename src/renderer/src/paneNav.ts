import type { LayoutNode } from '../../shared/types'

export type Direction = 'left' | 'right' | 'up' | 'down'

export interface PaneRect {
  id: string
  x: number
  y: number
  w: number
  h: number
}

/** Fractions are floats; compare edges with a tolerance rather than exactly. */
const EPS = 1e-6

/**
 * Where each pane sits, as fractions of the tab in a 0..1 box.
 *
 * Derived from the tree's `sizes` rather than from `getBoundingClientRect()`,
 * because the DOM lies in two states this app actually has: panes in background
 * tabs are `display: none`, and maximize detaches every other pane from the
 * document — both report a zero rect. The fractions are always available and
 * do not depend on when a render happened.
 */
export function paneRects(node: LayoutNode, x = 0, y = 0, w = 1, h = 1): PaneRect[] {
  if (node.type === 'pane') return [{ id: node.id, x, y, w, h }]
  const out: PaneRect[] = []
  let offset = 0
  node.children.forEach((child, i) => {
    // Fall back to an even share if sizes ever gets out of step with children.
    const frac = node.sizes[i] ?? 1 / node.children.length
    if (node.orientation === 'row') {
      out.push(...paneRects(child, x + w * offset, y, w * frac, h))
    } else {
      out.push(...paneRects(child, x, y + h * offset, w, h * frac))
    }
    offset += frac
  })
  return out
}

/**
 * The pane a directional move should land on, or null at the edge.
 *
 * Candidates must be strictly past the source edge AND share some of its
 * perpendicular span — a pane sitting only diagonally is not "to the right".
 * Nearest wins; ties go to the one overlapping most, which is what makes
 * `→` from a full-height pane land on the neighbour it actually faces.
 *
 * Deliberately does not wrap: sliding off the right edge back to the far left
 * loses you rather than helping.
 */
export function neighbour(rects: PaneRect[], fromId: string, dir: Direction): string | null {
  const from = rects.find((r) => r.id === fromId)
  if (!from) return null

  const gapTo = (r: PaneRect): number | null => {
    switch (dir) {
      case 'right':
        return r.x + EPS >= from.x + from.w ? r.x - (from.x + from.w) : null
      case 'left':
        return r.x + r.w <= from.x + EPS ? from.x - (r.x + r.w) : null
      case 'down':
        return r.y + EPS >= from.y + from.h ? r.y - (from.y + from.h) : null
      case 'up':
        return r.y + r.h <= from.y + EPS ? from.y - (r.y + r.h) : null
    }
  }

  const overlapWith = (r: PaneRect): number => {
    const horizontal = dir === 'left' || dir === 'right'
    const a0 = horizontal ? from.y : from.x
    const a1 = horizontal ? from.y + from.h : from.x + from.w
    const b0 = horizontal ? r.y : r.x
    const b1 = horizontal ? r.y + r.h : r.x + r.w
    return Math.min(a1, b1) - Math.max(a0, b0)
  }

  let best: { id: string; gap: number; overlap: number } | null = null
  for (const r of rects) {
    if (r.id === fromId) continue
    const gap = gapTo(r)
    if (gap === null) continue
    const overlap = overlapWith(r)
    if (overlap <= EPS) continue
    const closer = !best || gap < best.gap - EPS
    const tiedButWider = best !== null && Math.abs(gap - best.gap) <= EPS && overlap > best.overlap
    if (closer || tiedButWider) best = { id: r.id, gap, overlap }
  }
  return best?.id ?? null
}

/**
 * Next/previous id in reading order, wrapping at both ends.
 *
 * Wrapping is right here where the directional moves refuse it: cycling is an
 * explicit "show me the next one" and running out at the last pane would just
 * look broken.
 */
export function step(ids: string[], fromId: string, delta: 1 | -1): string | null {
  if (ids.length < 2) return null
  const i = ids.indexOf(fromId)
  if (i === -1) return ids[0] ?? null
  return ids[(i + delta + ids.length) % ids.length] ?? null
}
