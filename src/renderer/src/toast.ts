let toast: HTMLElement | null = null

const isMac = window.lightclaude.platform === 'darwin'

export function initUpdateToast(): void {
  window.lightclaude.updates.onAvailable((info) => showAvailable(info.version))
  window.lightclaude.updates.onProgress((p) => showProgress(p.percent, p.transferred, p.total))
  window.lightclaude.updates.onDownloaded(() => showMessage('Restarting to install…'))
  window.lightclaude.updates.onError(() => {
    showMessage('Update failed — will retry next launch.')
    window.setTimeout(dismiss, 6000)
  })
}

function ensureToast(): HTMLElement {
  if (toast) {
    toast.textContent = ''
    return toast
  }
  toast = document.createElement('div')
  toast.id = 'update-toast'
  document.body.appendChild(toast)
  return toast
}

function dismiss(): void {
  toast?.remove()
  toast = null
}

function showAvailable(version: string): void {
  const el = ensureToast()

  const text = document.createElement('div')
  text.className = 'toast-text'
  text.textContent = `Update available — v${version}`

  const actions = document.createElement('div')
  actions.className = 'toast-actions'
  const update = document.createElement('button')
  update.className = 'shortcuts-primary'
  update.textContent = isMac ? 'Download' : 'Update'
  update.addEventListener('click', () => {
    window.lightclaude.updates.download()
    if (isMac) dismiss() // browser takes over; unsigned mac builds can't self-update
    else showMessage('Starting download…')
  })
  const later = document.createElement('button')
  later.className = 'shortcuts-secondary'
  later.textContent = 'Later'
  // Session-only dismissal: the deferred check asks again on next app open.
  later.addEventListener('click', dismiss)
  actions.append(update, later)

  el.append(text, actions)
}

function showProgress(percent: number, transferred: number, total: number): void {
  const el = ensureToast()

  const text = document.createElement('div')
  text.className = 'toast-text'
  const mb = (n: number): string => (n / 1048576).toFixed(1)
  text.textContent = `Downloading update… ${Math.round(percent)}% (${mb(transferred)} / ${mb(total)} MB)`

  const track = document.createElement('div')
  track.className = 'toast-progress'
  const fill = document.createElement('div')
  fill.className = 'toast-progress-fill'
  fill.style.width = `${Math.min(100, Math.max(0, percent))}%`
  track.appendChild(fill)

  el.append(text, track)
}

function showMessage(message: string): void {
  const el = ensureToast()
  const text = document.createElement('div')
  text.className = 'toast-text'
  text.textContent = message
  el.appendChild(text)
}
