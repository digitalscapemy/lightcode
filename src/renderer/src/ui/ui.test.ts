import { describe, expect, it } from 'vitest'
import { ICON_NAMES, icon } from './icons'
import { toastLifetime } from './toast'

describe('toastLifetime', () => {
  // Something that went wrong must not vanish before anyone read it.
  it('keeps errors until dismissed', () => {
    expect(toastLifetime({ tone: 'error' })).toBeNull()
    expect(toastLifetime({ tone: 'error', duration: 1000 })).toBeNull()
  })

  it('lets everything else fade, 5 s by default', () => {
    expect(toastLifetime({})).toBe(5000)
    expect(toastLifetime({ tone: 'success' })).toBe(5000)
    expect(toastLifetime({ tone: 'warning', duration: 8000 })).toBe(8000)
  })
})

describe('icons', () => {
  it('renders every icon as a sized, colour-inheriting SVG', () => {
    for (const name of ICON_NAMES) {
      const svg = icon(name, 20)
      expect(svg).toMatch(/^<svg class="icon" width="20" height="20" viewBox="0 0 16 16"/)
      expect(svg).toContain('stroke="currentColor"')
      expect(svg).toContain('aria-hidden="true"')
      expect(svg.endsWith('</svg>')).toBe(true)
    }
  })

  it('draws Fan-out, Squad and Orchestra differently', () => {
    const a = icon('fanOut')
    const b = icon('squad')
    const c = icon('orchestra')
    expect(new Set([a, b, c]).size).toBe(3)
  })
})
