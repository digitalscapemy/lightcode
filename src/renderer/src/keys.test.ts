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

describe('matchShortcut, existing shortcuts still require Shift', () => {
  // Regression guard: the Shift gate moved below the zoom cases, so these are
  // the ones that would silently break if it ended up in the wrong place.
  it.each([
    ['KeyE', 'split-right'],
    ['KeyD', 'split-down'],
    ['KeyS', 'split-down'],
    ['KeyT', 'new-tab'],
    ['KeyW', 'close-pane'],
    ['KeyM', 'mission-control'],
    ['KeyJ', 'pane-attention']
  ])('Ctrl+Shift+%s -> %s', (code, action) => {
    expect(matchShortcut(key(code, ctrlShift))).toBe(action)
  })

  // Ctrl+J is a literal newline in a terminal, so the Shift is what keeps this
  // clear of the shell rather than a stylistic choice.
  it('leaves bare Ctrl+J to the terminal', () => {
    expect(matchShortcut(key('KeyJ', ctrl))).toBeNull()
  })

  it.each(['KeyE', 'KeyD', 'KeyT', 'KeyW', 'KeyM', 'KeyJ'])('Ctrl+%s (no Shift) is not a shortcut', (code) => {
    expect(matchShortcut(key(code, ctrl))).toBeNull()
  })
})

describe('matchShortcut, font zoom', () => {
  it('accepts + with or without Shift, because "+" IS Shift+Equal', () => {
    expect(matchShortcut(key('Equal', ctrl))).toBe('font-larger')
    expect(matchShortcut(key('Equal', ctrlShift))).toBe('font-larger')
  })

  it('shrinks on plain Minus', () => {
    expect(matchShortcut(key('Minus', ctrl))).toBe('font-smaller')
    expect(onMac(key('Minus', { metaKey: true }))).toBe('font-smaller')
  })

  it('leaves Ctrl+Shift+Minus alone, that is Ctrl+_, which is undo in zsh', () => {
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

describe('matchShortcut, rejects everything else', () => {
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

describe('pane navigation, Ctrl+Tab is Ctrl on BOTH platforms', () => {
  it('cycles panes on Windows', () => {
    expect(matchShortcut(key('Tab', ctrl))).toBe('pane-next')
    expect(matchShortcut(key('Tab', ctrlShift))).toBe('pane-prev')
  })

  it('cycles panes on macOS too, Cmd+Tab belongs to the OS', () => {
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

describe('pane navigation, Mod+Alt+Arrow', () => {
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
  it('leaves bare Tab alone, shell and Claude Code need it for completion', () => {
    expect(matchShortcut(key('Tab'))).toBeNull()
    expect(matchShortcut(key('Tab', { shiftKey: true }))).toBeNull()
    expect(onMac(key('Tab'))).toBeNull()
  })

  it('leaves bare arrows alone, history and cursor motion', () => {
    for (const code of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']) {
      expect(matchShortcut(key(code)), code).toBeNull()
      expect(matchShortcut(key(code, { shiftKey: true })), code).toBeNull()
    }
  })

  it('leaves Alt+letter alone, Alt+B / Alt+F are word motions', () => {
    expect(matchShortcut(key('KeyB', { altKey: true }))).toBeNull()
    expect(matchShortcut(key('KeyF', { altKey: true }))).toBeNull()
    // Still nothing even with the platform modifier: only arrows may use Alt.
    expect(matchShortcut(key('KeyB', { ctrlKey: true, altKey: true }))).toBeNull()
  })

  it('leaves Ctrl+letter alone on macOS, those are terminal control codes', () => {
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

describe('matchShortcut, crew approve', () => {
  // Y for yes. Shift keeps it clear of Ctrl+Y, which is yank in readline.
  it('Ctrl+Shift+Y approves, on both platforms with their own modifier', () => {
    expect(matchShortcut(key('KeyY', ctrlShift))).toBe('crew-approve')
    expect(onMac(key('KeyY', { metaKey: true, shiftKey: true }))).toBe('crew-approve')
  })

  it('leaves bare Ctrl+Y to the shell', () => {
    expect(matchShortcut(key('KeyY', ctrl))).toBeNull()
  })
})

describe('matchShortcut, orchestra panel', () => {
  it('Ctrl+Shift+O toggles the panel, on both platforms with their own modifier', () => {
    expect(matchShortcut(key('KeyO', ctrlShift))).toBe('orch-panel')
    expect(onMac(key('KeyO', { metaKey: true, shiftKey: true }))).toBe('orch-panel')
  })

  it('leaves bare Ctrl+O to the shell', () => {
    expect(matchShortcut(key('KeyO', ctrl))).toBeNull()
  })
})


describe('SHORTCUT_KEYS, every label is a key that works', () => {
  // Turns "Mod+Shift+P" into the KeyboardEvent that pressing it produces.
  const CODES: Record<string, string> = {
    '/': 'Slash', '=': 'Equal', '-': 'Minus', '0': 'Digit0', Enter: 'Enter', Tab: 'Tab',
    Left: 'ArrowLeft', Right: 'ArrowRight', Up: 'ArrowUp', Down: 'ArrowDown'
  }
  function press(spec: string, mac: boolean): KeyboardEvent {
    const parts = spec.split('+')
    const k = parts.pop()!
    const mods = { ctrlKey: false, metaKey: false, shiftKey: false, altKey: false }
    for (const m of parts) {
      if (m === 'Mod') mods[mac ? 'metaKey' : 'ctrlKey'] = true
      if (m === 'Ctrl') mods.ctrlKey = true
      if (m === 'Shift') mods.shiftKey = true
      if (m === 'Alt') mods.altKey = true
    }
    return { code: CODES[k] ?? `Key${k}`, ...mods } as unknown as KeyboardEvent
  }

  it.each(['win32', 'darwin'])('on %s', async (platform) => {
    vi.resetModules()
    vi.stubGlobal('window', { lightclaude: { platform } })
    const keys = await import('./keys')
    for (const [action, spec] of Object.entries(keys.SHORTCUT_KEYS)) {
      expect([action, keys.matchShortcut(press(spec, platform === 'darwin'))]).toEqual([action, action])
    }
  })

  it('writes keys the platform way', async () => {
    vi.resetModules()
    vi.stubGlobal('window', { lightclaude: { platform: 'win32' } })
    const keys = await import('./keys')
    expect(keys.formatKeys('Mod+Shift+P', false)).toBe('Ctrl+Shift+P')
    expect(keys.formatKeys('Mod+Shift+P', true)).toBe('⌘⇧P')
    expect(keys.formatKeys('Mod+Alt+Left', true)).toBe('⌘⌥←')
  })
})

describe('new shortcuts keep clear of terminal keys', () => {
  it('needs Shift for P, /, F, L and Enter on Windows', () => {
    for (const code of ['KeyP', 'Slash', 'KeyF', 'KeyL', 'Enter']) {
      expect(matchShortcut(key(code, ctrl))).toBeNull()
    }
  })

  // Ctrl+K is readline's kill-line; only Cmd+K on macOS opens the palette.
  it('leaves Ctrl+K to the shell, takes Cmd+K on macOS', () => {
    expect(matchShortcut(key('KeyK', ctrl))).toBeNull()
    expect(onMac(key('KeyK', { metaKey: true }))).toBe('command-palette')
    expect(onMac(key('KeyK', { ctrlKey: true }))).toBeNull()
  })
})
