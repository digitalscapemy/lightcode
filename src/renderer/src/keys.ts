export type ShortcutAction =
  | 'split-right'
  | 'split-down'
  | 'new-tab'
  | 'close-pane'
  | 'mission-control'

const isMac = window.lightclaude.platform === 'darwin'

export function matchShortcut(e: KeyboardEvent): ShortcutAction | null {
  // Cmd+Shift+<key> on macOS, Ctrl+Shift+<key> elsewhere.
  const mod = isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
  if (!mod || !e.shiftKey || e.altKey) return null
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

export function initShortcuts(handlers: Record<ShortcutAction, () => void>): void {
  window.addEventListener(
    'keydown',
    (e) => {
      const action = matchShortcut(e)
      if (!action) return
      e.preventDefault()
      e.stopPropagation()
      handlers[action]()
    },
    { capture: true }
  )
}
