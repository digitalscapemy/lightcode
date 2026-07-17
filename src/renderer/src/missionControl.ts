import { basename, contextWindowFor, fmtTokens, focusPane, panes } from './app'
import {
  babysitterCapped,
  babysitterCount,
  isBabysitterOn,
  onBabysitterChange,
  toggleBabysitter
} from './babysitter'
import { collectPaneIds, paneStatus, paneUsage, state } from './store'
import { paneNodes } from './splitTree'
import type { PaneStatus } from '../../shared/ipc'
import type { TabState } from '../../shared/types'

const STATUS_TEXT: Record<PaneStatus, string> = {
  working: 'working',
  'waiting-input': 'waiting',
  'waiting-approval': 'needs approval',
  idle: 'idle'
}

let overlay: HTMLElement | null = null
let listEl: HTMLElement
let composeInput: HTMLInputElement
let sendBtn: HTMLButtonElement
let countEl: HTMLElement
let ticker: number | null = null
/** Broadcast selection — persists across the live re-renders. */
const selected = new Set<string>()

export function toggleMissionControl(): void {
  if (overlay) closeMission()
  else openMission()
}

export function openMission(): void {
  if (overlay) return
  build()
  ticker = window.setInterval(render, 1000)
  onBabysitterChange(render)
  render()
}

function closeMission(): void {
  if (ticker !== null) {
    window.clearInterval(ticker)
    ticker = null
  }
  onBabysitterChange(() => {})
  document.removeEventListener('keydown', onKeydown, { capture: true })
  overlay?.remove()
  overlay = null
  if (state.focusedPaneId) panes.get(state.focusedPaneId)?.focus()
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    e.stopPropagation()
    closeMission()
  }
}

function build(): void {
  overlay = document.createElement('div')
  overlay.id = 'mission-overlay'
  overlay.addEventListener('pointerdown', (e) => {
    if (e.target === overlay) closeMission()
  })

  const modal = document.createElement('div')
  modal.className = 'mission-modal'
  overlay.appendChild(modal)

  const header = document.createElement('div')
  header.className = 'mission-header'
  const title = document.createElement('span')
  title.textContent = 'Mission Control'
  const close = document.createElement('button')
  close.className = 'mission-close'
  close.textContent = '×'
  close.addEventListener('click', closeMission)
  header.append(title, close)
  modal.appendChild(header)

  // Selection toolbar for broadcast targeting.
  const toolbar = document.createElement('div')
  toolbar.className = 'mission-toolbar'
  const mkSel = (label: string, fn: () => void): HTMLButtonElement => {
    const b = document.createElement('button')
    b.className = 'mission-secondary'
    b.textContent = label
    b.addEventListener('click', () => {
      fn()
      render()
    })
    return b
  }
  toolbar.append(
    mkSel('Select all', () => forEachRow((id) => selected.add(id))),
    mkSel('Waiting', () => {
      selected.clear()
      forEachRow((id) => {
        const s = paneStatus.get(id)?.status
        if (s === 'waiting-input' || s === 'waiting-approval') selected.add(id)
      })
    }),
    mkSel('None', () => selected.clear())
  )
  modal.appendChild(toolbar)

  listEl = document.createElement('div')
  listEl.className = 'mission-list'
  modal.appendChild(listEl)

  // Broadcast compose box.
  const footer = document.createElement('div')
  footer.className = 'mission-compose'
  composeInput = document.createElement('input')
  composeInput.className = 'mission-compose-input'
  composeInput.placeholder = 'Broadcast a command to selected panes…'
  composeInput.spellcheck = false
  composeInput.addEventListener('keydown', (e) => {
    e.stopPropagation()
    if (e.key === 'Enter') broadcast()
    else if (e.key === 'Escape') closeMission()
  })
  composeInput.addEventListener('input', updateSend)
  countEl = document.createElement('span')
  countEl.className = 'mission-count'
  sendBtn = document.createElement('button')
  sendBtn.className = 'mission-primary'
  sendBtn.addEventListener('click', broadcast)
  footer.append(composeInput, countEl, sendBtn)
  modal.appendChild(footer)

  document.addEventListener('keydown', onKeydown, { capture: true })
  document.body.appendChild(overlay)
}

/** Visit every pane currently listed (has an assigned Claude session). */
function forEachRow(fn: (id: string) => void): void {
  for (const tab of state.tabs) {
    for (const id of sessionPanes(tab)) fn(id)
  }
}

function sessionPanes(tab: TabState): string[] {
  return collectPaneIds(tab).filter((id) => paneStatus.has(id) && panes.has(id))
}

function render(): void {
  if (!overlay) return
  // Prune selection of panes that vanished.
  for (const id of [...selected]) if (!panes.has(id)) selected.delete(id)

  listEl.textContent = ''
  let any = false
  const now = Date.now()
  for (const tab of state.tabs) {
    const ids = sessionPanes(tab)
    if (ids.length === 0) continue
    any = true
    const group = document.createElement('div')
    group.className = 'mission-group'
    group.textContent = tab.name
    listEl.appendChild(group)
    for (const id of ids) listEl.appendChild(buildRow(tab, id, now))
  }
  if (!any) {
    const empty = document.createElement('div')
    empty.className = 'mission-empty'
    empty.textContent = 'No active Claude sessions yet — run claude in a pane.'
    listEl.appendChild(empty)
  }
  updateSend()
}

/** Refresh only the target count + Send button (cheap; runs on every keystroke). */
function updateSend(): void {
  const n = selected.size
  countEl.textContent = n ? `${n} selected` : ''
  sendBtn.textContent = n ? `Send → ${n}` : 'Send'
  sendBtn.disabled = n === 0 || composeInput.value.trim() === ''
}

function buildRow(tab: TabState, id: string, now: number): HTMLElement {
  const status = paneStatus.get(id)
  const usage = paneUsage.get(id)
  const row = document.createElement('div')
  row.className = 'mission-row'

  const check = document.createElement('input')
  check.type = 'checkbox'
  check.className = 'mission-check'
  check.checked = selected.has(id)
  check.addEventListener('change', () => {
    if (check.checked) selected.add(id)
    else selected.delete(id)
    render()
  })

  const dot = document.createElement('span')
  dot.className = 'mission-dot'
  if (status && status.status !== 'idle') dot.dataset['status'] = status.status

  const name = document.createElement('span')
  name.className = 'mission-name'
  name.textContent = panes.get(id)?.label() ?? 'Terminal'

  const project = document.createElement('span')
  project.className = 'mission-project'
  const cwd = paneNodes(tab.layout).find((p) => p.id === id)?.cwd ?? tab.projectPath
  project.textContent = basename(cwd)

  const meta = document.createElement('span')
  meta.className = 'mission-meta'
  meta.textContent = metaText(status?.status, usage)

  const elapsed = document.createElement('span')
  elapsed.className = 'mission-elapsed'
  elapsed.textContent = status?.lastActivity ? fmtElapsed(now - status.lastActivity) : ''

  const baby = document.createElement('button')
  baby.className = 'mission-baby'
  const on = isBabysitterOn(id)
  baby.classList.toggle('on', on)
  const count = babysitterCount(id)
  baby.textContent = on ? (count > 0 ? `🤖 ${count}` : '🤖') : '🤖'
  baby.title = on
    ? babysitterCapped(id)
      ? 'Babysitter paused — nudge limit reached; type in the pane to resume'
      : 'Auto-continue ON — click to disable'
    : 'Auto-continue OFF — click to keep Claude going when it finishes'
  baby.addEventListener('click', (e) => {
    e.stopPropagation()
    toggleBabysitter(id)
    render()
  })

  row.append(check, dot, name, project, meta, elapsed, baby)
  row.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('.mission-check, .mission-baby')) return
    focusPane(id)
    closeMission()
  })
  return row
}

function metaText(
  status: PaneStatus | undefined,
  usage: ReturnType<typeof paneUsage.get>
): string {
  const parts: string[] = []
  if (status && status !== 'idle') parts.push(STATUS_TEXT[status])
  if (usage) {
    if (usage.model) parts.push(usage.model.replace(/^claude-/, ''))
    if (usage.contextTokens > 0) {
      const pct = Math.round((usage.contextTokens / contextWindowFor(usage.model)) * 100)
      parts.push(`ctx ${pct}%`)
    }
    // Output tokens, not the all-in sum: that sum is ~99% cache reads (the same
    // prefix re-counted each turn) and reaches hundreds of millions saying nothing.
    if (usage.totals.output > 0) parts.push(`out ${fmtTokens(usage.totals.output)}`)
  }
  return parts.join('  ·  ')
}

function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  return `${Math.floor(m / 60)}h`
}

function broadcast(): void {
  const text = composeInput.value
  if (!text.trim() || selected.size === 0) return
  for (const id of selected) {
    if (panes.has(id)) window.lightclaude.pty.write(id, text + '\r')
  }
  composeInput.value = ''
  render()
  composeInput.focus()
}
