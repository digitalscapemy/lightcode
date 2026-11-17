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
 *
 * All four share the one modal shell in ui/modal.ts (Escape, click-outside,
 * focus trap, focus restored afterwards); only what they ask differs.
 */
import { modalButton, openModal } from './ui/modal'

/** A text-only dialog body, the shape every dialog here starts from. */
function textBody(body: HTMLElement, message: string): void {
  body.className = 'shortcuts-body confirm-text'
  body.textContent = message
}

/**
 * Listen for one key while a dialog is open, in the capture phase so it is
 * answered here rather than by the app behind the overlay. Returns the remover.
 */
function onKey(handler: (e: KeyboardEvent) => void): () => void {
  document.addEventListener('keydown', handler, { capture: true })
  return () => document.removeEventListener('keydown', handler, { capture: true })
}

/**
 * The same overlay with several answers, returning which was chosen or null when
 * dismissed. Two buttons cannot express "yes, but not that part" — closing a tab
 * of worktrees is a real three-way question, and folding it into yes/no would
 * make one of the answers unreachable.
 *
 * The last button is the primary one; dismissing is never destructive.
 *
 * `notes`, when given, holds a caveat per button (null for none). A button with
 * one is dimmed and carries it as its tooltip, but can still be chosen.
 */
export function choiceDialog(
  message: string,
  labels: string[],
  notes?: (string | null)[]
): Promise<number | null> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (answer: number | null): void => {
      if (settled) return
      settled = true
      m.close()
      resolve(answer)
    }
    const m = openModal({ className: 'confirm-modal', onDismiss: () => finish(null) })
    textBody(m.body, message)

    const cancel = modalButton('Cancel')
    cancel.addEventListener('click', () => finish(null))
    m.footer.appendChild(cancel)
    labels.forEach((label, i) => {
      const btn = modalButton(label, i === labels.length - 1 ? 'primary' : 'secondary')
      const note = notes?.[i]
      if (note) {
        btn.title = note
        btn.classList.add('choice-caveat')
      }
      btn.addEventListener('click', () => finish(i))
      m.footer.appendChild(btn)
    })
    ;(m.footer.lastElementChild as HTMLElement | null)?.focus()
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
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      removeKey()
      m.close()
      resolve()
    }
    const m = openModal({ className: 'confirm-modal', onDismiss: finish })
    textBody(m.body, message)
    const accept = modalButton(label, 'primary')
    accept.addEventListener('click', finish)
    m.footer.appendChild(accept)
    const removeKey = onKey((e) => {
      if (e.key !== 'Enter') return
      e.stopPropagation()
      finish()
    })
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
  /** Filled in and selected, for a suggestion that is usually right. */
  initial?: string
}): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (answer: string | null): void => {
      if (settled) return
      settled = true
      removeKey()
      m.close()
      resolve(answer)
    }
    const m = openModal({ className: 'confirm-modal', onDismiss: () => finish(null) })
    m.body.className = 'shortcuts-body confirm-text'

    const label = document.createElement('div')
    label.textContent = opts.message
    const input = document.createElement('input')
    input.className = 'prompt-input'
    input.placeholder = opts.placeholder ?? ''
    input.value = opts.initial ?? ''
    input.spellcheck = false
    const hint = document.createElement('div')
    hint.className = 'prompt-hint'
    m.body.append(label, input, hint)

    const cancel = modalButton('Cancel')
    const accept = modalButton(opts.confirmLabel ?? 'Create', 'primary')
    m.footer.append(cancel, accept)

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

    // Enter is handled here rather than by the app behind the overlay;
    // keys.ts already stands aside while an input has focus.
    const removeKey = onKey((e) => {
      if (e.key !== 'Enter') return
      e.stopPropagation()
      if (!accept.disabled) finish(input.value.trim())
    })

    input.addEventListener('input', revalidate)
    cancel.addEventListener('click', () => finish(null))
    accept.addEventListener('click', () => finish(input.value.trim()))
    revalidate()
    input.focus()
    if (opts.initial) input.select()
  })
}

export function confirmDialog(message: string, confirmLabel = 'Continue'): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (answer: boolean): void => {
      if (settled) return // Enter fires both the key handler and the button
      settled = true
      removeKey()
      m.close()
      resolve(answer)
    }
    // Clicking off the dialog is a "no" — the destructive answer is never the
    // one you get by dismissing something.
    const m = openModal({ className: 'confirm-modal', onDismiss: () => finish(false) })
    textBody(m.body, message)
    const cancel = modalButton('Cancel')
    const accept = modalButton(confirmLabel, 'primary')
    m.footer.append(cancel, accept)
    cancel.addEventListener('click', () => finish(false))
    accept.addEventListener('click', () => finish(true))
    const removeKey = onKey((e) => {
      if (e.key !== 'Enter') return
      e.stopPropagation()
      finish(true)
    })
    accept.focus()
  })
}
