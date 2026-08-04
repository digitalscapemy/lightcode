/**
 * In-app replacement for window.confirm().
 *
 * The native dialog is a modal WINDOW, and that is two separate problems for a
 * terminal app. It blocks the renderer outright for as long as it is open —
 * nothing paints and no cursor blinks, so every pane looks hung. And it
 * deactivates the window, which leaves xterm's focus flag stale on the way
 * back: that flag only flips on a real focus event, and a focus() call made
 * while the window is still inactive sets activeElement without firing one.
 * The pane then keeps taking keystrokes while drawing no cursor at all, since
 * cursorInactiveStyle is 'none' — the terminal looks frozen while it is
 * working perfectly.
 *
 * Staying inside the page avoids both. The full-screen overlay is also what
 * stops a second layout being picked while this one is still asking.
 */
export function confirmDialog(message: string, confirmLabel = 'Continue'): Promise<boolean> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div')
    overlay.id = 'shortcuts-overlay'

    const modal = document.createElement('div')
    modal.className = 'shortcuts-modal confirm-modal'

    const body = document.createElement('div')
    body.className = 'shortcuts-body confirm-text'
    body.textContent = message

    const footer = document.createElement('div')
    footer.className = 'shortcuts-footer confirm-actions'
    const cancel = document.createElement('button')
    cancel.className = 'shortcuts-secondary'
    cancel.textContent = 'Cancel'
    const accept = document.createElement('button')
    accept.className = 'shortcuts-primary'
    accept.textContent = confirmLabel
    footer.append(cancel, accept)

    modal.append(body, footer)
    overlay.appendChild(modal)

    let settled = false
    const finish = (answer: boolean): void => {
      if (settled) return // Enter fires both the key handler and the button
      settled = true
      document.removeEventListener('keydown', onKeydown, { capture: true })
      overlay.remove()
      resolve(answer)
    }
    // Capture phase, like the other modals: Escape must settle this dialog
    // rather than reach the app's own key handling behind it.
    const onKeydown = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' && e.key !== 'Enter') return
      e.stopPropagation()
      finish(e.key === 'Enter')
    }

    cancel.addEventListener('click', () => finish(false))
    accept.addEventListener('click', () => finish(true))
    // Clicking off the dialog is a "no" — the destructive answer is never the
    // one you get by dismissing something.
    overlay.addEventListener('pointerdown', (e) => {
      if (e.target === overlay) finish(false)
    })
    document.addEventListener('keydown', onKeydown, { capture: true })
    document.body.appendChild(overlay)
    accept.focus()
  })
}
