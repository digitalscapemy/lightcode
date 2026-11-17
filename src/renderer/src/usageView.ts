import type { AccountLimits, LimitWindow } from '../../shared/planLimits'
import { openModal } from './ui/modal'

/**
 * Plan limits per Claude account: the 5-hour session and the week, as used
 * percentages with their reset times. The same numbers as Claude Code's
 * /usage, saved by Light Code's status line on every refresh (see
 * shared/planLimits.ts), and re-read every few seconds while this is open.
 */

const POLL_MS = 5000

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text !== undefined) e.textContent = text
  return e
}

/** "3:00 PM" today, "Saturday 10:00 AM" within the week, a date beyond. */
function resetLabel(ms: number): string {
  const d = new Date(ms)
  const now = new Date()
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  if (d.toDateString() === now.toDateString()) return `Resets ${time}`
  if (ms - now.getTime() < 6.5 * 86_400_000) return `Resets ${d.toLocaleDateString(undefined, { weekday: 'long' })} ${time}`
  return `Resets ${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${time}`
}

function ago(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000))
  if (s < 60) return 'updated just now'
  if (s < 3600) return `updated ${Math.round(s / 60)} min ago`
  if (s < 86400) return `updated ${Math.round(s / 3600)} h ago`
  return `updated ${Math.round(s / 86400)} d ago`
}

function limitRow(title: string, w: LimitWindow | null): HTMLElement {
  const row = el('div', 'limit-row')
  const text = el('div', 'limit-text')
  text.appendChild(el('div', 'limit-title', title))
  const track = el('div', 'limit-track')
  const bar = el('div', 'limit-bar')
  track.appendChild(bar)
  const pct = el('div', 'limit-pct')

  if (!w) {
    text.appendChild(el('div', 'limit-sub', 'Not reported yet'))
    pct.textContent = ''
    row.classList.add('empty')
  } else if (w.resetsAt <= Date.now()) {
    // Seen before its reset; the new window shows after the next reply.
    text.appendChild(el('div', 'limit-sub', 'Reset since, updates after the next reply'))
    pct.textContent = '0% used'
  } else {
    const used = Math.min(100, Math.round(w.usedPercent))
    text.appendChild(el('div', 'limit-sub', resetLabel(w.resetsAt)))
    bar.style.width = `${used}%`
    if (used >= 90) bar.classList.add('high')
    else if (used >= 75) bar.classList.add('mid')
    pct.textContent = `${used}% used`
  }
  row.append(text, track, pct)
  return row
}

function card(a: AccountLimits): HTMLElement {
  const c = el('div', 'usage-card')
  const head = el('div', 'usage-head')
  const left = el('div')
  const dir = el('div', 'usage-dir', a.configDir)
  dir.title = a.configDir
  left.append(el('div', 'usage-name', a.label), dir)
  head.append(left, el('div', 'usage-when', a.updatedAt ? ago(a.updatedAt) : 'not seen yet'))
  c.appendChild(head)

  if (a.updatedAt === null) {
    c.appendChild(
      el(
        'div',
        'limit-hint',
        'Start Claude with this account in a Light Code pane. Its limits show here after the first reply.'
      )
    )
    return c
  }
  c.append(limitRow('Current session', a.fiveHour), limitRow('This week', a.sevenDay))
  return c
}

export function openUsage(): void {
  const m = openModal({
    title: 'Usage limits',
    subtitle: 'Your Claude plan limits per account, live from Claude Code.',
    icon: 'usage',
    className: 'usage-modal'
  })
  const list = el('div', 'usage-list')
  list.appendChild(el('div', 'usage-empty', 'Loading…'))
  const note = el(
    'p',
    'usage-note',
    'The same numbers as /usage in Claude Code. They refresh with every reply in a Light Code pane, so an account ' +
      'that has not been used here for a while shows when it was last seen. Add accounts under Accounts.'
  )
  m.body.append(list, note)

  const updated = el('span', 'usage-updated')
  const spacer = el('div')
  spacer.style.flex = '1'
  const done = el('button', 'shortcuts-primary', 'Done')
  m.footer.append(updated, spacer, done)

  let timer: number | null = null
  const stop = (): void => {
    if (timer !== null) window.clearInterval(timer)
    timer = null
  }
  done.addEventListener('click', () => {
    stop()
    m.close()
  })
  const load = async (): Promise<void> => {
    try {
      const data = await window.lightclaude.planLimits()
      if (!m.overlay.isConnected) return stop()
      list.replaceChildren(...data.map(card))
      updated.textContent = `Live · checked ${new Date().toLocaleTimeString()}`
    } catch {
      updated.textContent = 'Could not read limits'
    }
  }
  void load()
  timer = window.setInterval(() => {
    if (!m.overlay.isConnected) return stop()
    void load()
  }, POLL_MS)
}
