import { beforeAll, describe, expect, it, vi } from 'vitest'
import { FONT_SIZE_MAX, FONT_SIZE_MIN, clampFontSize } from './store'

type Match = (typeof import('./keys'))['matchShortcut']

// keys.ts reads the platform once at import time, so each platform needs its own
// module instance — resetModules is what makes the second import re-evaluate it.
async function loadFor(platform: string): Promise<Match> {
  vi.resetModules()
  vi.stubGlobal('window', { lightclaude: { platform } })
  return (await import('./keys')).matchShortcut
}

let matchShortcut: Match
let onMac: Match

beforeAll(async () => {
  onMac = await loadFor('darwin')
  matchShortcut = await loadFor('win32')
})

function key(code: string, mods: Record<string, boolean> = {}): KeyboardEvent {
  return {
    code,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    ...mods
  } as unknown as KeyboardEvent
}

const ctrl = { ctrlKey: true }
const ctrlShift = { ctrlKey: true, shiftKey: true }

describe('matchShortcut — existing shortcuts still require Shift', () => {
  // Regression guard: the Shift gate moved below the zoom cases, so these are
  // the ones that would silently break if it ended up in the wrong place.
  it.each([
    ['KeyE', 'split-right'],
    ['KeyD', 'split-down'],
    ['KeyS', 'split-down'],
    ['KeyT', 'new-tab'],
    ['KeyW', 'close-pane'],
    ['KeyM', 'mission-control']
  ])('Ctrl+Shift+%s -> %s', (code, action) => {
    expect(matchShortcut(key(code, ctrlShift))).toBe(action)
  })

  it.each(['KeyE', 'KeyD', 'KeyT', 'KeyW', 'KeyM'])('Ctrl+%s (no Shift) is not a shortcut', (code) => {
    expect(matchShortcut(key(code, ctrl))).toBeNull()
  })
})

describe('matchShortcut — font zoom', () => {
  it('accepts + with or without Shift, because "+" IS Shift+Equal', () => {
    expect(matchShortcut(key('Equal', ctrl))).toBe('font-larger')
    expect(matchShortcut(key('Equal', ctrlShift))).toBe('font-larger')
  })

  it('shrinks on plain Minus', () => {
    expect(matchShortcut(key('Minus', ctrl))).toBe('font-smaller')
    expect(onMac(key('Minus', { metaKey: true }))).toBe('font-smaller')
  })

  it('leaves Ctrl+Shift+Minus alone — that is Ctrl+_, which is undo in zsh', () => {
    // Windows-only collision in practice: there the platform modifier IS Ctrl,
    // so matching this would swallow the shell's undo. Asserted on both
    // platforms so the rule cannot drift apart later.
    expect(matchShortcut(key('Minus', ctrlShift))).toBeNull()
    expect(onMac(key('Minus', { metaKey: true, shiftKey: true }))).toBeNull()
    expect(onMac(key('Minus', { ctrlKey: true, shiftKey: true }))).toBeNull()
  })

  it('accepts the numpad keys, which carry no Shift', () => {
    expect(matchShortcut(key('NumpadAdd', ctrl))).toBe('font-larger')
    expect(matchShortcut(key('NumpadSubtract', ctrl))).toBe('font-smaller')
    expect(matchShortcut(key('Numpad0', ctrl))).toBe('font-reset')
  })

  it('resets on Ctrl+0', () => {
    expect(matchShortcut(key('Digit0', ctrl))).toBe('font-reset')
  })
})

describe('matchShortcut — rejects everything else', () => {
  it('needs the platform modifier', () => {
    expect(matchShortcut(key('Equal'))).toBeNull()
    expect(matchShortcut(key('KeyE', { shiftKey: true }))).toBeNull()
  })

  it('ignores the wrong modifier for this platform', () => {
    // Stubbed as win32: Cmd must not stand in for Ctrl.
    expect(matchShortcut(key('KeyE', { metaKey: true, shiftKey: true }))).toBeNull()
    expect(matchShortcut(key('Equal', { metaKey: true }))).toBeNull()
  })

  it('never fires with Alt held', () => {
    expect(matchShortcut(key('Equal', { ctrlKey: true, altKey: true }))).toBeNull()
    expect(matchShortcut(key('KeyE', { ctrlKey: true, shiftKey: true, altKey: true }))).toBeNull()
  })

  it('ignores unmapped keys', () => {
    expect(matchShortcut(key('KeyQ', ctrlShift))).toBeNull()
  })
})

describe('pane navigation — Ctrl+Tab is Ctrl on BOTH platforms', () => {
  it('cycles panes on Windows', () => {
    expect(matchShortcut(key('Tab', ctrl))).toBe('pane-next')
    expect(matchShortcut(key('Tab', ctrlShift))).toBe('pane-prev')
  })

  it('cycles panes on macOS too — Cmd+Tab belongs to the OS', () => {
    expect(onMac(key('Tab', ctrl))).toBe('pane-next')
    expect(onMac(key('Tab', ctrlShift))).toBe('pane-prev')
    // Cmd+Tab must never be claimed: macOS owns it for app switching.
    expect(onMac(key('Tab', { metaKey: true }))).toBeNull()
  })

  it('ignores Tab with Alt, or with both modifiers held', () => {
    expect(matchShortcut(key('Tab', { ctrlKey: true, altKey: true }))).toBeNull()
    expect(matchShortcut(key('Tab', { ctrlKey: true, metaKey: true }))).toBeNull()
  })
})

describe('pane navigation — Mod+Alt+Arrow', () => {
  const modAlt = { ctrlKey: true, altKey: true }

  it.each([
    ['ArrowLeft', 'pane-left'],
    ['ArrowRight', 'pane-right'],
    ['ArrowUp', 'pane-up'],
    ['ArrowDown', 'pane-down']
  ])('Ctrl+Alt+%s -> %s', (code, action) => {
    expect(matchShortcut(key(code, modAlt))).toBe(action)
  })

  it('uses Cmd on macOS, not Ctrl', () => {
    expect(onMac(key('ArrowRight', { metaKey: true, altKey: true }))).toBe('pane-right')
    expect(onMac(key('ArrowRight', { ctrlKey: true, altKey: true }))).toBeNull()
  })

  it('ignores Shift, leaving that combination free', () => {
    expect(matchShortcut(key('ArrowRight', { ...modAlt, shiftKey: true }))).toBeNull()
  })
})

describe('keys the shell must keep receiving', () => {
  // The whole feature is wrong if any of these stops reaching the terminal.
  it('leaves bare Tab alone — shell and Claude Code need it for completion', () => {
    expect(matchShortcut(key('Tab'))).toBeNull()
    expect(matchShortcut(key('Tab', { shiftKey: true }))).toBeNull()
    expect(onMac(key('Tab'))).toBeNull()
  })

  it('leaves bare arrows alone — history and cursor motion', () => {
    for (const code of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']) {
      expect(matchShortcut(key(code)), code).toBeNull()
      expect(matchShortcut(key(code, { shiftKey: true })), code).toBeNull()
    }
  })

  it('leaves Alt+letter alone — Alt+B / Alt+F are word motions', () => {
    expect(matchShortcut(key('KeyB', { altKey: true }))).toBeNull()
    expect(matchShortcut(key('KeyF', { altKey: true }))).toBeNull()
    // Still nothing even with the platform modifier: only arrows may use Alt.
    expect(matchShortcut(key('KeyB', { ctrlKey: true, altKey: true }))).toBeNull()
  })

  it('leaves Ctrl+letter alone on macOS — those are terminal control codes', () => {
    expect(onMac(key('KeyC', { ctrlKey: true }))).toBeNull()
    expect(onMac(key('KeyD', { ctrlKey: true }))).toBeNull()
  })
})

describe('clampFontSize', () => {
  it('holds the size inside the allowed range', () => {
    expect(clampFontSize(FONT_SIZE_MIN - 5)).toBe(FONT_SIZE_MIN)
    expect(clampFontSize(FONT_SIZE_MAX + 5)).toBe(FONT_SIZE_MAX)
    expect(clampFontSize(14)).toBe(14)
  })

  it('rounds, so a stale fractional value from disk cannot drift', () => {
    expect(clampFontSize(13.4)).toBe(13)
    expect(clampFontSize(13.6)).toBe(14)
  })
})
