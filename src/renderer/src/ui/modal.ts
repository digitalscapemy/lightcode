import { icon, type IconName } from './icons'

/**
 * One modal shell for the whole app.
 *
 * Every dialog used to build its own overlay, its own Escape handling and its
 * own buttons. This is the one place that does it: an in-page overlay (never a
 * native dialog — see confirmDialog.ts for why), Escape and click-outside to
 * dismiss, Tab kept inside the dialog, and focus handed back to whatever had it
 * before — usually a terminal, which must not be left without its cursor.
 */

export interface ModalOptions {
  title?: string
  subtitle?: string
  icon?: IconName
  /** Extra class on the dialog box (sizes: confirm-modal, fanout-modal…). */
  className?: string
  /** Called when the user dismisses (Escape, click outside, close button). */
  onDismiss?: () => void
  /** Show a × in the header. Default: true when there is a title. */
  closeButton?: boolean
}

export interface ModalHandle {
  overlay: HTMLElement
  modal: HTMLElement
  body: HTMLElement
  footer: HTMLElement
  /** Close without calling onDismiss. Safe to call twice. */
  close(): void
}

/** Focusable things a Tab can land on, in order. */
function focusables(root: HTMLElement): HTMLElement[] {
  return [
    ...root.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])'
    )
  ].filter((el) => el.offsetParent !== null)
}

export function openModal(opts: ModalOptions = {}): ModalHandle {
  const previous = document.activeElement as HTMLElement | null

  const overlay = document.createElement('div')
  overlay.id = 'shortcuts-overlay'
  const modal = document.createElement('div')
  modal.className = 'shortcuts-modal' + (opts.className ? ` ${opts.className}` : '')
  modal.setAttribute('role', 'dialog')
  modal.setAttribute('aria-modal', 'true')

  if (opts.title) {
    const header = document.createElement('div')
    header.className = 'shortcuts-header modal-header'
    const heading = document.createElement('div')
    heading.className = 'modal-heading'
    if (opts.icon) {
      const ic = document.createElement('span')
      ic.className = 'modal-icon'
      ic.innerHTML = icon(opts.icon, 18)
      heading.appendChild(ic)
    }
    const text = document.createElement('div')
    const title = document.createElement('div')
    title.className = 'modal-title'
    title.textContent = opts.title
    text.appendChild(title)
    if (opts.subtitle) {
      const sub = document.createElement('div')
      sub.className = 'modal-subtitle'
      sub.textContent = opts.subtitle
      text.appendChild(sub)
    }
    heading.appendChild(text)
    header.appendChild(heading)
    if (opts.closeButton !== false) {
      const x = document.createElement('button')
      x.className = 'shortcuts-close'
      x.title = 'Close (Esc)'
      x.innerHTML = icon('close', 16)
      x.addEventListener('click', () => dismiss())
      header.appendChild(x)
    }
    modal.appendChild(header)
    modal.setAttribute('aria-label', opts.title)
  }

  const body = document.createElement('div')
  body.className = 'shortcuts-body'
  const footer = document.createElement('div')
  footer.className = 'shortcuts-footer confirm-actions'
  modal.append(body, footer)
  overlay.appendChild(modal)

  let closed = false
  const close = (): void => {
    if (closed) return
    closed = true
    document.removeEventListener('keydown', onKeydown, { capture: true })
    overlay.remove()
    // Back to where the user was — a terminal left unfocused draws no cursor.
    if (previous && previous.isConnected) previous.focus()
  }
  const dismiss = (): void => {
    if (closed) return
    close()
    opts.onDismiss?.()
  }

  const onKeydown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      e.preventDefault()
      dismiss()
      return
    }
    // Keep Tab inside the dialog.
    if (e.key === 'Tab') {
      const items = focusables(modal)
      if (items.length === 0) return
      const first = items[0]!
      const last = items[items.length - 1]!
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
  }

  overlay.addEventListener('pointerdown', (e) => {
    if (e.target === overlay) dismiss()
  })
  document.addEventListener('keydown', onKeydown, { capture: true })
  document.body.appendChild(overlay)

  return { overlay, modal, body, footer, close }
}

/** A footer button with the shared look. The last primary one is the default action. */
export function modalButton(
  label: string,
  kind: 'primary' | 'secondary' | 'danger' = 'secondary'
): HTMLButtonElement {
  const btn = document.createElement('button')
  btn.className =
    kind === 'primary' ? 'shortcuts-primary' : kind === 'danger' ? 'shortcuts-secondary btn-danger' : 'shortcuts-secondary'
  btn.textContent = label
  return btn
}
