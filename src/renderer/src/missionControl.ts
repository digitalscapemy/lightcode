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
import { crewHue, groupByCrew } from '../../shared/crew'
import type { PaneStatus } from '../../shared/ipc'
import type { PaneNodeCrew, TabState } from '../../shared/types'

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
/** Held so closing actually stops repainting a panel that no longer exists. */
let unsubscribe: (() => void) | null = null
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
  unsubscribe = onBabysitterChange(render)
  render()
}

function closeMission(): void {
  if (ticker !== null) {
    window.clearInterval(ticker)
    ticker = null
  }
  unsubscribe?.()
  unsubscribe = null
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

  // Whether this window is the one remembering its layout. Said out loud
  // because the failure is otherwise invisible: a second Light Code used to
  // overwrite the first one's tabs on quit, and nothing anywhere admitted it.
  void window.lightclaude.state.owned().then((owned) => {
    if (owned || !overlay) return
    const note = document.createElement('div')
    note.className = 'mission-note'
    note.textContent =
      'Layout is not being saved, another Light Code window owns it. Everything else works normally.'
    header.after(note)
  })

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
  /**
   * The agent CLI switch, deliberately at the other end of the toolbar.
   *
   * It sat next to Select all / Waiting / None and read as a fourth way of
   * filtering rows, which it is nothing like: those change what is ticked, this
   * decides whether a program is allowed to drive your panes at all. A spacer
   * and a status dot say "different kind of thing" faster than any wording.
   */
  const lcBtn = document.createElement('button')
  lcBtn.className = 'mission-secondary mission-lc'
  const lcDot = document.createElement('span')
  lcDot.className = 'mission-lc-dot'
  const lcText = document.createElement('span')
  lcBtn.append(lcDot, lcText)
  const paintLc = (enabled: boolean): void => {
    lcText.textContent = 'Agent CLI'
    lcBtn.classList.toggle('active', enabled)
    lcBtn.title = enabled
      ? 'On, an agent can run `lc` and drive other panes. Panes it drives are marked.'
      : 'Off, `lc` is not listening at all. Click to let agents drive panes.'
  }
  // Off until main says otherwise, and main is asked every time this opens —
  // what it reports is whether the socket is actually there, so a listener that
  // failed to bind or died since cannot leave this dot lit.
  paintLc(false)
  void window.lightclaude.lc.state().then((s) => paintLc(s.enabled))
  lcBtn.addEventListener('click', () => {
    const next = !lcBtn.classList.contains('active')
    void window.lightclaude.lc.setEnabled(next).then((s) => {
      paintLc(s.enabled)
      // Asked for on and still off: the socket could not be opened. Without
      // this the button just refuses to move and looks broken rather than
      // honest.
      if (next && !s.enabled) {
        lcBtn.title = 'Could not open the socket, the agent CLI is still off.'
      }
    })
  })

  const spacer = document.createElement('div')
  spacer.className = 'mission-toolbar-gap'

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
  toolbar.append(spacer, lcBtn)
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
    // An orchestra's panes together, under its colour. A tab with no crew in
    // it is one plain group and lists exactly as it always did.
    const crewOf = new Map<string, PaneNodeCrew>()
    for (const node of paneNodes(tab.layout)) if (node.crew) crewOf.set(node.id, node.crew)
    for (const block of groupByCrew(ids, (id) => crewOf.get(id)?.id)) {
      if (block.crew !== null) listEl.appendChild(crewHeader(block.crew, block.items, crewOf))
      for (const id of block.items) listEl.appendChild(buildRow(tab, id, now))
    }
  }
  if (!any) {
    const empty = document.createElement('div')
    empty.className = 'mission-empty'
    empty.textContent = 'No active Claude sessions yet, run claude in a pane.'
    listEl.appendChild(empty)
  }
  updateSend()
}

/** The line over an orchestra's rows: its colour, and who conducts it. */
function crewHeader(crewId: string, ids: string[], crewOf: Map<string, PaneNodeCrew>): HTMLElement {
  const el = document.createElement('div')
  el.className = 'mission-crew'
  el.style.setProperty('--crew-hue', String(crewHue(crewId)))
  const swatch = document.createElement('span')
  swatch.className = 'mission-crew-swatch'
  const label = document.createElement('span')
  const lead = ids.find((id) => crewOf.get(id)?.lead)
  label.textContent = lead ? `♪ ${panes.get(lead)?.label() ?? 'orchestra'}` : '♪ orchestra'
  el.append(swatch, label)
  return el
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
  // A crew member is named the way its lead addresses it.
  const crew = paneNodes(tab.layout).find((p) => p.id === id)?.crew
  if (crew && !crew.lead) name.textContent = `@${crew.handle}`

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
      ? 'Babysitter paused, nudge limit reached; type in the pane to resume'
      : 'Auto-continue ON, click to disable'
    : 'Auto-continue OFF, click to keep Claude going when it finishes'
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

export function metaText(
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

/** How long ago, in the one unit that matters: 42s, 7m, 3h. */
export function fmtElapsed(ms: number): string {
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
