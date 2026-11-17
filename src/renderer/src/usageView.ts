import { billable, fmtTokens, type AccountUsage } from '../../shared/accountUsage'
import { openModal } from './ui/modal'

/**
 * Token usage per Claude account: today, the last 7 days as bars, and when it
 * was last active. Live while open (every 15 s; main caches for 10 s, so this
 * stays cheap). Counted from the transcripts on this computer: these are not
 * Anthropic's plan limits, and the dialog says so.
 */

function ago(ms: number | null): string {
  if (ms === null) return 'no activity this week'
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000))
  if (s < 60) return 'active just now'
  if (s < 3600) return `active ${Math.round(s / 60)} min ago`
  if (s < 86400) return `active ${Math.round(s / 3600)} h ago`
  return `active ${Math.round(s / 86400)} d ago`
}

function weekday(day: string): string {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(y!, m! - 1, d!, 12).toLocaleDateString(undefined, { weekday: 'short' })
}

function stat(label: string, value: string, sub: string): HTMLElement {
  const s = document.createElement('div')
  s.className = 'usage-stat'
  const l = document.createElement('div')
  l.className = 'usage-stat-label'
  l.textContent = label
  const v = document.createElement('div')
  v.className = 'usage-stat-value'
  v.textContent = value
  const b = document.createElement('div')
  b.className = 'usage-stat-sub'
  b.textContent = sub
  s.append(l, v, b)
  return s
}

function card(a: AccountUsage): HTMLElement {
  const el = document.createElement('div')
  el.className = 'usage-card'

  const head = document.createElement('div')
  head.className = 'usage-head'
  const left = document.createElement('div')
  const name = document.createElement('div')
  name.className = 'usage-name'
  name.textContent = a.label
  const dir = document.createElement('div')
  dir.className = 'usage-dir'
  dir.textContent = a.configDir
  dir.title = a.configDir
  left.append(name, dir)
  const when = document.createElement('div')
  when.className = 'usage-when'
  when.textContent = ago(a.lastActivity)
  head.append(left, when)

  const stats = document.createElement('div')
  stats.className = 'usage-stats'
  stats.append(
    stat('Today', fmtTokens(billable(a.today)), `${fmtTokens(a.today.output)} output`),
    stat('Last 7 days', fmtTokens(billable(a.last7)), `${fmtTokens(a.last7.output)} output`),
    stat('Cache reads, 7 days', fmtTokens(a.last7.cacheRead), 'cheaper, counted apart')
  )

  // Seven bars, oldest first; today is the last one and stands out.
  const chart = document.createElement('div')
  chart.className = 'usage-chart'
  const max = Math.max(1, ...a.days.map((d) => billable(d.totals)))
  a.days.forEach((d, i) => {
    const isToday = i === a.days.length - 1
    const v = billable(d.totals)
    const col = document.createElement('div')
    col.className = 'usage-col' + (isToday ? ' today' : '')
    col.title = `${d.day}: ${fmtTokens(v)} tokens (${fmtTokens(d.totals.output)} output)`
    const track = document.createElement('div')
    track.className = 'usage-track'
    const bar = document.createElement('div')
    bar.className = 'usage-bar'
    bar.style.height = `${v > 0 ? Math.max(4, Math.round((v / max) * 100)) : 1}%`
    track.appendChild(bar)
    const lab = document.createElement('div')
    lab.className = 'usage-col-label'
    lab.textContent = isToday ? 'Today' : weekday(d.day)
    col.append(track, lab)
    chart.appendChild(col)
  })

  el.append(head, stats, chart)
  return el
}

export function openUsage(): void {
  const m = openModal({
    title: 'Token usage',
    subtitle: 'Per Claude account, from the session transcripts on this computer.',
    icon: 'usage',
    className: 'usage-modal'
  })
  const list = document.createElement('div')
  list.className = 'usage-list'
  const loading = document.createElement('div')
  loading.className = 'usage-empty'
  loading.textContent = 'Reading transcripts…'
  list.appendChild(loading)
  const note = document.createElement('p')
  note.className = 'usage-note'
  note.textContent =
    'Tokens = input + output + cache writes. These are counts, not your plan limits: Anthropic does not ' +
    'write those into transcripts, and usage from other computers is not included. Add accounts under Claude accounts.'
  m.body.append(list, note)

  const updated = document.createElement('span')
  updated.className = 'usage-updated'
  const spacer = document.createElement('div')
  spacer.style.flex = '1'
  const done = document.createElement('button')
  done.className = 'shortcuts-primary'
  done.textContent = 'Done'
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
      const data = await window.lightclaude.accountUsage()
      if (!m.overlay.isConnected) return stop()
      list.replaceChildren(...data.map(card))
      updated.textContent = `Live · updated ${new Date().toLocaleTimeString()}`
    } catch {
      updated.textContent = 'Could not read usage'
    }
  }
  void load()
  timer = window.setInterval(() => {
    if (!m.overlay.isConnected) return stop()
    void load()
  }, 15_000)
}
