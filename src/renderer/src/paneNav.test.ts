import { describe, expect, it } from 'vitest'
import { LAYOUT_PRESETS, buildLayout } from './layouts'
import { neighbour, paneRects, step } from './paneNav'
import { paneIds } from './splitTree'
import type { PaneRect } from './paneNav'

/** Build a preset by id with predictable ids p0, p1, … in reading order. */
function layoutOf(presetId: string) {
  const preset = LAYOUT_PRESETS.find((p) => p.id === presetId)
  if (!preset) throw new Error(`no preset ${presetId}`)
  let n = 0
  return buildLayout(preset.spec, () => `p${n++}`)
}

function rectOf(rects: PaneRect[], id: string): PaneRect {
  const r = rects.find((x) => x.id === id)
  if (!r) throw new Error(`no rect for ${id}`)
  return r
}

function overlaps(a: PaneRect, b: PaneRect): boolean {
  const dx = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
  const dy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
  return dx > 1e-9 && dy > 1e-9
}

describe('paneRects', () => {
  it('tiles the whole tab with no gaps, for every preset', () => {
    for (const preset of LAYOUT_PRESETS) {
      const rects = paneRects(layoutOf(preset.id))
      const area = rects.reduce((sum, r) => sum + r.w * r.h, 0)
      expect(area, preset.id).toBeCloseTo(1, 6)
    }
  })

  it('never overlaps two panes, for every preset', () => {
    for (const preset of LAYOUT_PRESETS) {
      const rects = paneRects(layoutOf(preset.id))
      for (let i = 0; i < rects.length; i++) {
        for (let j = i + 1; j < rects.length; j++) {
          expect(overlaps(rects[i]!, rects[j]!), `${preset.id}: ${rects[i]!.id}/${rects[j]!.id}`).toBe(
            false
          )
        }
      }
    }
  })

  it('stays inside the unit box', () => {
    for (const preset of LAYOUT_PRESETS) {
      for (const r of paneRects(layoutOf(preset.id))) {
        expect(r.x, preset.id).toBeGreaterThanOrEqual(-1e-9)
        expect(r.y, preset.id).toBeGreaterThanOrEqual(-1e-9)
        expect(r.x + r.w, preset.id).toBeLessThanOrEqual(1 + 1e-9)
        expect(r.y + r.h, preset.id).toBeLessThanOrEqual(1 + 1e-9)
      }
    }
  })

  it('emits rects in the same order as paneIds', () => {
    // goToPane maps a cycling index onto a pane, so the two orders must agree
    // or Ctrl+Tab would land somewhere the geometry disagrees about.
    for (const preset of LAYOUT_PRESETS) {
      const layout = layoutOf(preset.id)
      expect(paneRects(layout).map((r) => r.id), preset.id).toEqual(paneIds(layout))
    }
  })
})

describe('neighbour — 3x3 grid', () => {
  // p0 p1 p2
  // p3 p4 p5
  // p6 p7 p8
  const rects = paneRects(layoutOf('9-grid'))

  it('moves in all four directions from the centre', () => {
    expect(neighbour(rects, 'p4', 'left')).toBe('p3')
    expect(neighbour(rects, 'p4', 'right')).toBe('p5')
    expect(neighbour(rects, 'p4', 'up')).toBe('p1')
    expect(neighbour(rects, 'p4', 'down')).toBe('p7')
  })

  it('stops at the edges instead of wrapping', () => {
    expect(neighbour(rects, 'p0', 'left')).toBeNull()
    expect(neighbour(rects, 'p0', 'up')).toBeNull()
    expect(neighbour(rects, 'p8', 'right')).toBeNull()
    expect(neighbour(rects, 'p8', 'down')).toBeNull()
  })

  it('never skips over the adjacent pane', () => {
    expect(neighbour(rects, 'p0', 'right')).toBe('p1')
    expect(neighbour(rects, 'p2', 'left')).toBe('p1')
    expect(neighbour(rects, 'p0', 'down')).toBe('p3')
    expect(neighbour(rects, 'p6', 'up')).toBe('p3')
  })
})

describe('neighbour — layouts with no second row or column', () => {
  it('returns null vertically in a single row', () => {
    const rects = paneRects(layoutOf('3-cols'))
    expect(neighbour(rects, 'p1', 'up')).toBeNull()
    expect(neighbour(rects, 'p1', 'down')).toBeNull()
    expect(neighbour(rects, 'p1', 'right')).toBe('p2')
  })

  it('returns null horizontally in a single column', () => {
    const rects = paneRects(layoutOf('3-rows'))
    expect(neighbour(rects, 'p1', 'left')).toBeNull()
    expect(neighbour(rects, 'p1', 'right')).toBeNull()
    expect(neighbour(rects, 'p1', 'down')).toBe('p2')
  })
})

describe('neighbour — uneven layout (one tall pane facing a stack)', () => {
  // 3-left is { row: [p0, { col: [p1, p2] }] } — p0 is full height on the left,
  // p1 and p2 are stacked on the right. Both are equally far from p0, so the
  // tie-break decides, and either stacked pane must find its way back to p0.
  const rects = paneRects(layoutOf('3-left'))

  it('picks a facing pane when two are equally close', () => {
    expect(neighbour(rects, 'p0', 'right')).toBe('p1')
  })

  it('returns to the tall pane from either stacked pane', () => {
    expect(neighbour(rects, 'p1', 'left')).toBe('p0')
    expect(neighbour(rects, 'p2', 'left')).toBe('p0')
  })

  it('moves within the stack', () => {
    expect(neighbour(rects, 'p1', 'down')).toBe('p2')
    expect(neighbour(rects, 'p2', 'up')).toBe('p1')
    expect(neighbour(rects, 'p1', 'up')).toBeNull()
  })
})

describe('step', () => {
  const ids = ['a', 'b', 'c']

  it('advances and retreats', () => {
    expect(step(ids, 'a', 1)).toBe('b')
    expect(step(ids, 'b', -1)).toBe('a')
  })

  it('wraps at both ends', () => {
    expect(step(ids, 'c', 1)).toBe('a')
    expect(step(ids, 'a', -1)).toBe('c')
  })

  it('does nothing with a single pane', () => {
    expect(step(['only'], 'only', 1)).toBeNull()
    expect(step([], 'gone', 1)).toBeNull()
  })

  it('falls back to the first pane when the origin is unknown', () => {
    expect(step(ids, 'vanished', 1)).toBe('a')
  })
})
