import { icon, type IconName } from './icons'

/**
 * Small notices in the bottom-right corner.
 *
 * Replaces messages that used to vanish after a few seconds (a crew note, a
 * failed update) and raw errors in a blocking dialog. The rule that matters:
 * an error stays until it is dismissed — something that went wrong must not
 * disappear before anyone read it. Information and success fade on their own.
 *
 * The update offer has its own toast (src/toast.ts) because it owns a flow
 * (offer → download → restart); it shares this look, not this queue.
 */

export type ToastTone = 'info' | 'success' | 'warning' | 'error'

export interface ToastOptions {
  tone?: ToastTone
  title: string
  detail?: string
  action?: { label: string; run: () => void }
  /** ms before it fades; ignored for errors, which stay. Default 5000. */
  duration?: number
}

const TONE_ICON: Record<ToastTone, IconName> = {
  info: 'info',
  success: 'check',
  warning: 'warning',
  error: 'error'
}

/** Most toasts at once; the oldest goes when a new one would exceed it. */
const MAX_VISIBLE = 4

let stack: HTMLElement | null = null

function host(): HTMLElement {
  if (stack && stack.isConnected) return stack
  stack = document.createElement('div')
  stack.className = 'toast-stack'
  stack.setAttribute('role', 'status')
  stack.setAttribute('aria-live', 'polite')
  document.body.appendChild(stack)
  return stack
}

/** How long a toast stays, or null for "until dismissed". Exported for tests. */
export function toastLifetime(opts: Pick<ToastOptions, 'tone' | 'duration'>): number | null {
  if ((opts.tone ?? 'info') === 'error') return null
  return opts.duration ?? 5000
}

export function toast(opts: ToastOptions): () => void {
  const tone = opts.tone ?? 'info'
  const el = document.createElement('div')
  el.className = `ui-toast ui-toast-${tone}`
  if (tone === 'error') el.setAttribute('role', 'alert')

  const ic = document.createElement('span')
  ic.className = 'ui-toast-icon'
  ic.innerHTML = icon(TONE_ICON[tone], 16) // constant SVG only
  const text = document.createElement('div')
  text.className = 'ui-toast-text'
  const title = document.createElement('div')
  title.className = 'ui-toast-title'
  title.textContent = opts.title
  text.appendChild(title)
  if (opts.detail) {
    const detail = document.createElement('div')
    detail.className = 'ui-toast-detail'
    detail.textContent = opts.detail
    text.appendChild(detail)
  }
  el.append(ic, text)

  let timer: number | null = null
  const dismiss = (): void => {
    if (timer !== null) window.clearTimeout(timer)
    timer = null
    if (!el.isConnected) return
    el.classList.add('leaving')
    window.setTimeout(() => el.remove(), 150)
  }

  if (opts.action) {
    const btn = document.createElement('button')
    btn.className = 'btn btn-sm'
    btn.textContent = opts.action.label
    const run = opts.action.run
    btn.addEventListener('click', () => {
      dismiss()
      run()
    })
    el.appendChild(btn)
  }
  const close = document.createElement('button')
  close.className = 'btn btn-ghost btn-sm btn-icon ui-toast-close'
  close.title = 'Dismiss'
  close.innerHTML = icon('close', 14) // constant SVG only
  close.addEventListener('click', dismiss)
  el.appendChild(close)

  const box = host()
  box.appendChild(el)
  while (box.children.length > MAX_VISIBLE) box.firstElementChild?.remove()

  const life = toastLifetime(opts)
  if (life !== null) {
    const start = (): void => {
      timer = window.setTimeout(dismiss, life)
    }
    // Reading it should not race the timer.
    el.addEventListener('pointerenter', () => {
      if (timer !== null) window.clearTimeout(timer)
      timer = null
    })
    el.addEventListener('pointerleave', start)
    start()
  }
  return dismiss
}
