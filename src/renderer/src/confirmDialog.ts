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
/**
 * The same overlay with several answers, returning which was chosen or null when
 * dismissed. Two buttons cannot express "yes, but not that part" — closing a tab
 * of worktrees is a real three-way question, and folding it into yes/no would
 * make one of the answers unreachable.
 *
 * The last button is the primary one; dismissing is never destructive.
 */
export function choiceDialog(message: string, labels: string[]): Promise<number | null> {
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

    let settled = false
    const finish = (answer: number | null): void => {
      if (settled) return
      settled = true
      document.removeEventListener('keydown', onKeydown, { capture: true })
      overlay.remove()
      resolve(answer)
    }
    const onKeydown = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      finish(null)
    }

    const cancel = document.createElement('button')
    cancel.className = 'shortcuts-secondary'
    cancel.textContent = 'Cancel'
    cancel.addEventListener('click', () => finish(null))
    footer.appendChild(cancel)

    labels.forEach((label, i) => {
      const btn = document.createElement('button')
      btn.className = i === labels.length - 1 ? 'shortcuts-primary' : 'shortcuts-secondary'
      btn.textContent = label
      btn.addEventListener('click', () => finish(i))
      footer.appendChild(btn)
    })

    modal.append(body, footer)
    overlay.appendChild(modal)
    overlay.addEventListener('pointerdown', (e) => {
      if (e.target === overlay) finish(null)
    })
    document.addEventListener('keydown', onKeydown, { capture: true })
    document.body.appendChild(overlay)
    ;(footer.lastElementChild as HTMLElement | null)?.focus()
  })
}

/**
 * The same overlay, saying one thing with one button.
 *
 * For messages that have to be read rather than glanced at — a `fatal:` from git
 * naming a branch that already exists, say. The update toast is not the place:
 * it is a singleton owned by the updater, and borrowing it would mean an error
 * here could evict an update offer, or be evicted by one.
 */
export function alertDialog(message: string, label = 'OK'): Promise<void> {
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
    const accept = document.createElement('button')
    accept.className = 'shortcuts-primary'
    accept.textContent = label
    footer.appendChild(accept)
    modal.append(body, footer)
    overlay.appendChild(modal)

    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      document.removeEventListener('keydown', onKeydown, { capture: true })
      overlay.remove()
      resolve()
    }
    const onKeydown = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' && e.key !== 'Enter') return
      e.stopPropagation()
      finish()
    }
    accept.addEventListener('click', finish)
    overlay.addEventListener('pointerdown', (e) => {
      if (e.target === overlay) finish()
    })
    document.addEventListener('keydown', onKeydown, { capture: true })
    document.body.appendChild(overlay)
    accept.focus()
  })
}

/**
 * The same overlay, asking for a line of text rather than a yes.
 *
 * Resolves to the trimmed value, or null when dismissed. `validate` runs on every
 * keystroke so a bad name is refused before Enter rather than after — the button
 * simply stays disabled and says why, which is a better way to learn a rule than
 * a `fatal:` from git afterwards.
 */
export function promptDialog(opts: {
  message: string
  placeholder?: string
  confirmLabel?: string
  validate?: (value: string) => string | null
}): Promise<string | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div')
    overlay.id = 'shortcuts-overlay'

    const modal = document.createElement('div')
    modal.className = 'shortcuts-modal confirm-modal'

    const body = document.createElement('div')
    body.className = 'shortcuts-body confirm-text'
    const label = document.createElement('div')
    label.textContent = opts.message
    const input = document.createElement('input')
    input.className = 'prompt-input'
    input.placeholder = opts.placeholder ?? ''
    input.spellcheck = false
    const hint = document.createElement('div')
    hint.className = 'prompt-hint'
    body.append(label, input, hint)

    const footer = document.createElement('div')
    footer.className = 'shortcuts-footer confirm-actions'
    const cancel = document.createElement('button')
    cancel.className = 'shortcuts-secondary'
    cancel.textContent = 'Cancel'
    const accept = document.createElement('button')
    accept.className = 'shortcuts-primary'
    accept.textContent = opts.confirmLabel ?? 'Create'
    footer.append(cancel, accept)

    modal.append(body, footer)
    overlay.appendChild(modal)

    let settled = false
    const finish = (answer: string | null): void => {
      if (settled) return
      settled = true
      document.removeEventListener('keydown', onKeydown, { capture: true })
      overlay.remove()
      resolve(answer)
    }

    const problem = (): string | null => {
      const value = input.value.trim()
      if (value === '') return '' // nothing typed yet: no complaint, no button
      return opts.validate?.(value) ?? null
    }
    const revalidate = (): void => {
      const issue = problem()
      hint.textContent = issue ?? ''
      accept.disabled = input.value.trim() === '' || issue !== null
    }

    // Enter and Escape are handled here rather than by the app behind the
    // overlay; keys.ts already stands aside while an input has focus.
    const onKeydown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        finish(null)
        return
      }
      if (e.key === 'Enter') {
        e.stopPropagation()
        if (!accept.disabled) finish(input.value.trim())
      }
    }

    input.addEventListener('input', revalidate)
    cancel.addEventListener('click', () => finish(null))
    accept.addEventListener('click', () => finish(input.value.trim()))
    overlay.addEventListener('pointerdown', (e) => {
      if (e.target === overlay) finish(null)
    })
    document.addEventListener('keydown', onKeydown, { capture: true })
    document.body.appendChild(overlay)
    revalidate()
    input.focus()
  })
}

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
