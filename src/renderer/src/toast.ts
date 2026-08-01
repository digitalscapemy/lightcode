import { paneStatus } from './store'

import type { UpdateAvailableInfo } from '../../shared/ipc'

/**
 * What "Later" actually buys. The offer is deliberately NOT dismissible for
 * good: an update nobody installs is an update that never shipped, and the old
 * behaviour — one click and it never came back until the next launch — meant a
 * long-running window could sit versions behind for days.
 */
const SNOOZE_MS = 30 * 60 * 1000

const isMac = window.lightclaude.platform === 'darwin'

let toast: HTMLElement | null = null
/** The update on offer, kept so "Later" can bring back the same one. */
let offered: UpdateAvailableInfo | null = null
let snoozeTimer: number | null = null
let showAllNotes = false
/** True once the user has acted — from here the toast reports, never nags. */
let settled = false

export function initUpdateToast(): void {
  window.lightclaude.updates.onAvailable((info) => {
    offered = info
    if (!settled) showOffer()
  })
  window.lightclaude.updates.onProgress((p) => showProgress(p.percent, p.transferred, p.total))
  window.lightclaude.updates.onDownloaded(() => showMessage('Restarting to install…'))
  window.lightclaude.updates.onError(() => {
    // The offer stands — a failed download is a reason to ask again, not to
    // give up on the version.
    settled = false
    showMessage('Update failed — you can try again shortly.')
    window.setTimeout(() => {
      dismiss()
      snooze()
    }, 6000)
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

function clearSnooze(): void {
  if (snoozeTimer !== null) window.clearTimeout(snoozeTimer)
  snoozeTimer = null
}

/** Put the same offer back on screen after the snooze runs out. */
function snooze(): void {
  clearSnooze()
  snoozeTimer = window.setTimeout(() => {
    snoozeTimer = null
    if (!settled) showOffer()
  }, SNOOZE_MS)
}

/** Panes with a Claude turn actually in flight right now. */
function busyPanes(): number {
  let n = 0
  for (const u of paneStatus.values()) if (u.status === 'working') n++
  return n
}

function showOffer(): void {
  if (!offered) return
  clearSnooze()
  showAllNotes = false
  const el = ensureToast()

  const text = document.createElement('div')
  text.className = 'toast-text'
  text.textContent = `Update available — v${offered.version}`
  el.appendChild(text)

  if (offered.notes.length > 0) el.appendChild(notesBlock(offered.notes))

  el.appendChild(
    actions(
      { label: isMac ? 'Download' : 'Update', primary: true, action: onUpdateClick },
      {
        label: 'Later',
        title: 'Asks again in 30 minutes',
        action: () => {
          dismiss()
          snooze()
        }
      }
    )
  )
}

/**
 * The offered version's notes. They are written for the About dialog, so they
 * run long — the toast shows the gist and opens up on demand rather than
 * covering half the terminal uninvited.
 */
function notesBlock(notes: string[]): HTMLElement {
  const wrap = document.createElement('div')

  const list = document.createElement('ul')
  list.className = showAllNotes ? 'toast-notes' : 'toast-notes collapsed'
  for (const note of notes) {
    const li = document.createElement('li')
    li.textContent = note // text only: these came off the network
    list.appendChild(li)
  }
  wrap.appendChild(list)

  if (notes.length > 2 || notes.some((n) => n.length > 110)) {
    const more = document.createElement('button')
    more.className = 'toast-more'
    more.textContent = showAllNotes ? 'Show less' : 'Show all'
    more.addEventListener('click', () => {
      showAllNotes = !showAllNotes
      list.className = showAllNotes ? 'toast-notes' : 'toast-notes collapsed'
      more.textContent = showAllNotes ? 'Show less' : 'Show all'
    })
    wrap.appendChild(more)
  }
  return wrap
}

function onUpdateClick(): void {
  // macOS hands off to the browser and leaves the app running, so there is
  // nothing to warn about there. On Windows the installer quits the app the
  // moment the download lands — this is the last chance to say no, because
  // after it the panes go without another word.
  const busy = isMac ? 0 : busyPanes()
  if (busy > 0) {
    confirmBusy(busy)
    return
  }
  startUpdate()
}

function confirmBusy(n: number): void {
  const el = ensureToast()

  const text = document.createElement('div')
  text.className = 'toast-text'
  text.textContent =
    n === 1
      ? 'Claude is working in 1 pane. Updating closes the app as soon as the download finishes, ending that session.'
      : `Claude is working in ${n} panes. Updating closes the app as soon as the download finishes, ending those sessions.`
  el.appendChild(text)

  el.appendChild(
    actions(
      { label: 'Update anyway', primary: true, action: startUpdate },
      {
        label: 'Later',
        action: () => {
          dismiss()
          snooze()
        }
      }
    )
  )
}

function startUpdate(): void {
  window.lightclaude.updates.download()
  if (isMac) {
    // The browser takes over — unsigned mac builds can't self-update. So the
    // offer is deliberately NOT settled here: nothing in the app can tell
    // whether the .dmg was ever actually installed, and assuming it was is how
    // a Mac quietly sits three versions behind.
    dismiss()
    snooze()
    return
  }
  settled = true
  showMessage('Starting download…')
}

interface Action {
  label: string
  action: () => void
  primary?: boolean
  title?: string
}

function actions(...items: Action[]): HTMLElement {
  const row = document.createElement('div')
  row.className = 'toast-actions'
  for (const { label, action, primary, title } of items) {
    const btn = document.createElement('button')
    btn.className = primary ? 'shortcuts-primary' : 'shortcuts-secondary'
    btn.textContent = label
    if (title) btn.title = title
    btn.addEventListener('click', action)
    row.appendChild(btn)
  }
  return row
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
