import type { LayoutNode } from '../../shared/types'

/**
 * A layout shape, independent of pane identity.
 *
 * 'p' is one pane; { row } splits left-to-right; { col } stacks top-to-bottom.
 * The same spec drives both the real LayoutNode and the menu thumbnail, so a
 * preview can never drift from what picking it actually builds.
 */
export type LayoutSpec = 'p' | { row: LayoutSpec[] } | { col: LayoutSpec[] }

export interface LayoutPreset {
  /** Stable key, also used to mark the active preset in the picker. */
  id: string
  /** How many panes the shape holds. */
  count: number
  spec: LayoutSpec
}

function parts(spec: Exclude<LayoutSpec, 'p'>): LayoutSpec[] {
  return 'row' in spec ? spec.row : spec.col
}

export function paneCount(spec: LayoutSpec): number {
  return spec === 'p' ? 1 : parts(spec).reduce((n, c) => n + paneCount(c), 0)
}

/**
 * Grid of offered shapes, grouped by pane count in the picker.
 *
 * Deliberately a curated subset rather than every arrangement that exists:
 * past ~4 panes the distinct-looking options collapse into near-duplicates,
 * and a wall of them costs more to scan than it saves.
 */
export const LAYOUT_PRESETS: LayoutPreset[] = (
  [
    ['1', 'p'],
    ['2-cols', { row: ['p', 'p'] }],
    ['2-rows', { col: ['p', 'p'] }],
    ['3-cols', { row: ['p', 'p', 'p'] }],
    ['3-rows', { col: ['p', 'p', 'p'] }],
    ['3-left', { row: ['p', { col: ['p', 'p'] }] }],
    ['3-top', { col: ['p', { row: ['p', 'p'] }] }],
    ['4-grid', { row: [{ col: ['p', 'p'] }, { col: ['p', 'p'] }] }],
    ['4-cols', { row: ['p', 'p', 'p', 'p'] }],
    ['4-rows', { col: ['p', 'p', 'p', 'p'] }],
    ['4-left', { row: ['p', { col: ['p', 'p', 'p'] }] }],
    ['6-grid', { col: [{ row: ['p', 'p', 'p'] }, { row: ['p', 'p', 'p'] }] }],
    ['6-tall', { row: [{ col: ['p', 'p', 'p'] }, { col: ['p', 'p', 'p'] }] }],
    ['8-grid', { col: [{ row: ['p', 'p', 'p', 'p'] }, { row: ['p', 'p', 'p', 'p'] }] }],
    ['9-grid', { col: [3, 3, 3].map(() => ({ row: ['p', 'p', 'p'] })) as LayoutSpec[] }],
    ['12-grid', { col: [4, 4, 4].map(() => ({ row: ['p', 'p', 'p', 'p'] })) as LayoutSpec[] }],
    ['16-grid', { col: [4, 4, 4, 4].map(() => ({ row: ['p', 'p', 'p', 'p'] })) as LayoutSpec[] }]
  ] as [string, LayoutSpec][]
).map(([id, spec]) => ({ id, spec, count: paneCount(spec) }))

/**
 * Turn a spec into a real layout tree, consuming ids in reading order so the
 * caller controls which existing pane lands in which slot.
 */
export function buildLayout(spec: LayoutSpec, nextId: () => string): LayoutNode {
  if (spec === 'p') return { type: 'pane', id: nextId() }
  const children = parts(spec).map((c) => buildLayout(c, nextId))
  return {
    type: 'split',
    orientation: 'row' in spec ? 'row' : 'column',
    children,
    sizes: children.map(() => 1 / children.length)
  }
}

interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/** Flatten a spec into unit-box rectangles, in the same order buildLayout fills. */
function specRects(spec: LayoutSpec, x: number, y: number, w: number, h: number): Rect[] {
  if (spec === 'p') return [{ x, y, w, h }]
  const children = parts(spec)
  const n = children.length
  return children.flatMap((child, i) =>
    'row' in spec
      ? specRects(child, x + (w / n) * i, y, w / n, h)
      : specRects(child, x, y + (h / n) * i, w, h / n)
  )
}

const SVG_NS = 'http://www.w3.org/2000/svg'

/** Menu thumbnail, drawn from the same spec that builds the layout. */
export function layoutThumbnail(spec: LayoutSpec, size = 22): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', `0 0 ${size} ${size}`)
  svg.setAttribute('width', String(size))
  svg.setAttribute('height', String(size))
  // Inset by half a stroke so the outer edges aren't clipped by the viewBox.
  const pad = 0.5
  const gap = 1.5
  for (const r of specRects(spec, pad, pad, size - pad * 2, size - pad * 2)) {
    const rect = document.createElementNS(SVG_NS, 'rect')
    // Shrink each cell by half a gap per side; clamp so dense grids (4x4) keep
    // a visible body instead of collapsing to a hairline.
    const w = Math.max(r.w - gap, 1)
    const h = Math.max(r.h - gap, 1)
    rect.setAttribute('x', String(r.x + (r.w - w) / 2))
    rect.setAttribute('y', String(r.y + (r.h - h) / 2))
    rect.setAttribute('width', String(w))
    rect.setAttribute('height', String(h))
    rect.setAttribute('rx', '1')
    svg.appendChild(rect)
  }
  return svg
}
