export type ShortcutAction =
  | 'split-right'
  | 'split-down'
  | 'new-tab'
  | 'close-pane'
  | 'mission-control'
  | 'font-larger'
  | 'font-smaller'
  | 'font-reset'
  | 'pane-next'
  | 'pane-prev'
  | 'pane-left'
  | 'pane-right'
  | 'pane-up'
  | 'pane-down'

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
    default:
      return null
  }
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
