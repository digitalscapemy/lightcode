export type ShortcutAction =
  | 'split-right'
  | 'split-down'
  | 'new-tab'
  | 'close-pane'
  | 'mission-control'
  | 'git-tree'
  | 'font-larger'
  | 'font-smaller'
  | 'font-reset'
  | 'pane-next'
  | 'pane-prev'
  | 'pane-attention'
  | 'pane-left'
  | 'pane-right'
  | 'pane-up'
  | 'pane-down'
  | 'crew-approve'
  | 'orch-panel'
  | 'command-palette'
  | 'shortcut-help'
  | 'fan-out'
  | 'layout-picker'
  | 'pane-maximize'

const isMac = window.lightclaude.platform === 'darwin'

/**
 * How the platform modifier is written in UI text.
 *
 * One source of truth: tooltips used to hardcode "Ctrl" and so told macOS users
 * the wrong key. Anything user-facing that names a shortcut should build it from
 * this rather than spelling a modifier out.
 */
export const MOD_LABEL = isMac ? '⌘' : 'Ctrl'

export function matchShortcut(e: KeyboardEvent): ShortcutAction | null {
  // Ctrl+Tab is Ctrl on BOTH platforms, so it is matched ahead of the Mod gate
  // below — on macOS that gate wants Cmd, and Cmd+Tab belongs to the OS. Chrome
  // and VS Code use Ctrl+Tab on macOS for exactly the same reason.
  // Bare Tab is deliberately left alone: the shell and Claude Code need it for
  // completion, and a terminal always has focus here, so it is never free.
  if (e.code === 'Tab' && e.ctrlKey && !e.metaKey && !e.altKey) {
    return e.shiftKey ? 'pane-prev' : 'pane-next'
  }

  // Cmd+<key> on macOS, Ctrl+<key> elsewhere.
  const mod = isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
  if (!mod) return null

  // ⌘K opens the command palette on macOS, as it does in most Mac apps. Cmd
  // never reaches the terminal there, so nothing is taken from the shell. Not
  // on Windows/Linux: Ctrl+K is readline's kill-to-end-of-line.
  if (isMac && e.code === 'KeyK' && !e.shiftKey && !e.altKey) return 'command-palette'

  // Directional pane focus is the only thing allowed to hold Alt. Everything
  // else still bails on it, because Alt-modified keys are real terminal input
  // (Alt+B / Alt+F are word motions) and must keep reaching the shell.
  if (e.altKey) {
    if (e.shiftKey) return null
    switch (e.code) {
      case 'ArrowLeft':
        return 'pane-left'
      case 'ArrowRight':
        return 'pane-right'
      case 'ArrowUp':
        return 'pane-up'
      case 'ArrowDown':
        return 'pane-down'
      default:
        return null
    }
  }

  // Font zoom, matched before the Shift gate below. The two halves are NOT
  // symmetric, and the asymmetry is load-bearing:
  //
  //   Equal accepts Shift, because "+" IS Shift+Equal on most layouts.
  //   Minus rejects Shift, because "_" is Shift+Minus — and Ctrl+_ is `undo`
  //   in zsh and in bash's readline. On Windows the platform modifier is Ctrl,
  //   so matching it here would take the shell's undo away. macOS never had the
  //   collision (its modifier is Cmd), which is why this is Windows-only.
  switch (e.code) {
    case 'Equal':
    case 'NumpadAdd':
      return 'font-larger'
    case 'Minus':
    case 'NumpadSubtract':
      return e.shiftKey ? null : 'font-smaller'
    case 'Digit0':
    case 'Numpad0':
      return 'font-reset'
  }

  if (!e.shiftKey) return null
  switch (e.code) {
    case 'KeyE':
      return 'split-right'
    case 'KeyD':
    case 'KeyS':
      return 'split-down'
    case 'KeyT':
      return 'new-tab'
    case 'KeyW':
      return 'close-pane'
    case 'KeyM':
      return 'mission-control'
    // G for git. Free, and the only letter anyone guesses for this.
    case 'KeyG':
      return 'git-tree'
    // J for "jump". Deliberately not a letter the shell wants: Ctrl+J is a
    // newline in a terminal, but the Shift here keeps it clear of that.
    case 'KeyJ':
      return 'pane-attention'
    // Y for yes: approve the permission prompt the focused orchestra is stuck
    // on. Asks first the first time each session (crewStrip.approveFromKey).
    case 'KeyY':
      return 'crew-approve'
    // O for orchestra: the panel of every crew in the window.
    case 'KeyO':
      return 'orch-panel'
    // P for palette — the same key VS Code and Windows Terminal use.
    case 'KeyP':
      return 'command-palette'
    // "?" — the key everyone tries first for help.
    case 'Slash':
      return 'shortcut-help'
    case 'KeyF':
      return 'fan-out'
    case 'KeyL':
      return 'layout-picker'
    case 'Enter':
      return 'pane-maximize'
    default:
      return null
  }
}

/**
 * How each shortcut is written for people: menus, tooltips, the palette and the
 * cheat-sheet all read it from here. "Mod" is Ctrl, or ⌘ on macOS. A test checks
 * every entry against matchShortcut, so the text cannot promise a key that does
 * nothing.
 */
export const SHORTCUT_KEYS: Record<ShortcutAction, string> = {
  'command-palette': 'Mod+Shift+P',
  'shortcut-help': 'Mod+Shift+/',
  'new-tab': 'Mod+Shift+T',
  'split-right': 'Mod+Shift+E',
  'split-down': 'Mod+Shift+D',
  'close-pane': 'Mod+Shift+W',
  'pane-maximize': 'Mod+Shift+Enter',
  'pane-next': 'Ctrl+Tab',
  'pane-prev': 'Ctrl+Shift+Tab',
  'pane-left': 'Mod+Alt+Left',
  'pane-right': 'Mod+Alt+Right',
  'pane-up': 'Mod+Alt+Up',
  'pane-down': 'Mod+Alt+Down',
  'pane-attention': 'Mod+Shift+J',
  'layout-picker': 'Mod+Shift+L',
  'fan-out': 'Mod+Shift+F',
  'orch-panel': 'Mod+Shift+O',
  'crew-approve': 'Mod+Shift+Y',
  'git-tree': 'Mod+Shift+G',
  'mission-control': 'Mod+Shift+M',
  'font-larger': 'Mod+=',
  'font-smaller': 'Mod+-',
  'font-reset': 'Mod+0'
}

const MAC_SYMBOLS: Record<string, string> = {
  Mod: '⌘',
  Ctrl: '⌃',
  Shift: '⇧',
  Alt: '⌥',
  Enter: '↩',
  Left: '←',
  Right: '→',
  Up: '↑',
  Down: '↓',
  Tab: '⇥'
}

/** "Mod+Shift+P" → "Ctrl+Shift+P" (Windows/Linux) or "⌘⇧P" (macOS). */
export function formatKeys(spec: string, mac = isMac): string {
  const parts = spec.split('+').filter(Boolean)
  // A literal "+" key would split into an empty part; none of ours use it.
  if (mac) return parts.map((p) => MAC_SYMBOLS[p] ?? p).join('')
  return parts.map((p) => (p === 'Mod' ? 'Ctrl' : p)).join('+')
}

/** The shortcut for an action, written for this platform. */
export function shortcutLabel(action: ShortcutAction): string {
  return formatKeys(SHORTCUT_KEYS[action])
}

/** Used by xterm's attachCustomKeyEventHandler so app shortcuts bubble out. */
export function isAppShortcut(e: KeyboardEvent): boolean {
  return matchShortcut(e) !== null
}

/**
 * True when focus is in a real text field — a tab/pane rename box or the Mission
 * Control compose input. Explicitly NOT xterm's hidden textarea, which is where
 * every keystroke lands while a terminal has focus; treating that as a text
 * field would disable every shortcut inside the terminal.
 */
function inTextField(): boolean {
  const el = document.activeElement
  if (!el || el.classList.contains('xterm-helper-textarea')) return false
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA'
}

export function initShortcuts(handlers: Record<ShortcutAction, () => void>): void {
  window.addEventListener(
    'keydown',
    (e) => {
      // This listener is the first in the renderer for every keystroke — ahead
      // of the rename inputs' own stopPropagation, which only covers the bubble
      // phase. Without this bail, typing a name fires app shortcuts, and the
      // rename's blur handler then commits the half-typed value.
      if (inTextField()) return
      const action = matchShortcut(e)
      if (!action) return
      e.preventDefault()
      e.stopPropagation()
      handlers[action]()
    },
    { capture: true }
  )
}
