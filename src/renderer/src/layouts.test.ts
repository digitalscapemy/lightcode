import { describe, expect, it } from 'vitest'
import { LAYOUT_PRESETS, buildLayout, paneCount } from './layouts'
import type { LayoutNode } from '../../shared/types'

function ids(node: LayoutNode): string[] {
  return node.type === 'pane' ? [node.id] : node.children.flatMap(ids)
}

function splits(node: LayoutNode): Extract<LayoutNode, { type: 'split' }>[] {
  if (node.type === 'pane') return []
  return [node, ...node.children.flatMap(splits)]
}

describe('layout presets', () => {
  it('declare a count matching their actual shape', () => {
    for (const preset of LAYOUT_PRESETS) {
      expect(paneCount(preset.spec), preset.id).toBe(preset.count)
    }
  })

  it('have unique ids', () => {
    const seen = LAYOUT_PRESETS.map((p) => p.id)
    expect(new Set(seen).size).toBe(seen.length)
  })

  it('offer the counts the picker advertises', () => {
    const counts = [...new Set(LAYOUT_PRESETS.map((p) => p.count))]
    expect(counts).toEqual([1, 2, 3, 4, 6, 8, 9, 12, 16])
  })
})

describe('buildLayout', () => {
  it('consumes exactly count ids, in reading order', () => {
    for (const preset of LAYOUT_PRESETS) {
      let n = 0
      const tree = buildLayout(preset.spec, () => `p${n++}`)
      expect(n, preset.id).toBe(preset.count)
      // Reading order matters: applyLayout maps surviving panes onto slots by
      // position, so slot k must always be the k-th id handed out.
      expect(ids(tree), preset.id).toEqual(
        Array.from({ length: preset.count }, (_, i) => `p${i}`)
      )
    }
  })

  it('gives every split sizes that match its children and sum to 1', () => {
    for (const preset of LAYOUT_PRESETS) {
      let n = 0
      for (const split of splits(buildLayout(preset.spec, () => `p${n++}`))) {
        expect(split.sizes.length, preset.id).toBe(split.children.length)
        expect(split.sizes.reduce((a, b) => a + b, 0), preset.id).toBeCloseTo(1)
      }
    }
  })

  it('never emits a split with fewer than two children', () => {
    // A one-child split would render a gutter with nothing to resize against.
    for (const preset of LAYOUT_PRESETS) {
      let n = 0
      for (const split of splits(buildLayout(preset.spec, () => `p${n++}`))) {
        expect(split.children.length, preset.id).toBeGreaterThan(1)
      }
    }
  })
})
