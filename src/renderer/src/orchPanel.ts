import { crewEvent, panes, revealPane, setCrewPaused, setCrewSetting } from './app'
import { confirmDialog } from './confirmDialog'
import { crewEvents, eventText } from './crewEvents'
import { buildWorkerCard, crewSignal, onCrewSignal, readLastLine, setPanelReading } from './crewStrip'
import type { StripWorker, WorkerCard } from './crewStrip'
import { fmtElapsed, metaText } from './missionControl'
import { paneNodes } from './splitTree'
import { openSquad } from './squadUi'
import { paneStatus, paneUsage, persist, reportLanded, restoredQuiet, state } from './store'
import { crewHue, crewStatus } from '../../shared/crew'
import type { CrewEvent } from '../../shared/crew'
import type { SquadReportFile, SquadReportUpdate } from '../../shared/ipc'
import type { PaneNode, TabState } from '../../shared/types'

/**
 * The Orchestra panel: every crew in the window, in one place beside the panes.
 *
 * A lead's strip shows its own workers inside its own pane, which is where a
 * person conducting looks. This is the view from above — every orchestra in
 * every tab, the same worker cards, what has just happened across all of them,
 * the reports they have filed, and the few things only a person may allow a
 * crew: letting its lead answer permission prompts, refusing rather than
 * warning when it reaches past its own panes, holding it still.
 *
 * Docked like the git tree and for the same reason: it is read while you work.
 * Closed until asked for, and a window with no crew in it shows only a way to
 * start one. Nothing here runs while it is closed, apart from the report
 * watch, which the lead's strip needs too and which only exists for crews
 * that have a squad folder.
 */

/** How many events the timeline shows. The rest are a scroll of `lc events` away. */
const TIMELINE_LENGTH = 20

let panel: HTMLElement | null = null
let body: HTMLElement | null = null
/** Cards by worker pane, reused across renders so a half-typed message survives. */
const cards = new Map<string, WorkerCard>()
/** Repaints each crew's header from the current statuses. Rebuilt every render. */
let headPainters: (() => void)[] = []
/**
 * Repaints each report row's unread dot, which a click on its author's card
 * can put out as well as opening it. Rebuilt every render.
 */
let reportPainters: (() => void)[] = []
let timelineEl: HTMLElement | null = null
let ticker: number | null = null
let unsubscribeSignal: (() => void) | null = null
let unsubscribeEvents: (() => void) | null = null
let renderPending = false
let timelinePending = false

export function initOrchPanel(): void {
  panel = document.getElementById('orch-panel')
  if (!panel) return
  panel.hidden = !state.orchPanelOpen
  build()
  render()
  syncLive()
}

export function toggleOrchPanel(): void {
  if (!panel) return
  panel.hidden = !panel.hidden
  state.orchPanelOpen = !panel.hidden
  persist()
  render()
  syncLive()
}

/**
 * Crews may have changed — a pane joined, left, closed, a setting moved.
 * Keeps the report watches in step whether or not the panel is open, and
 * redraws the panel if it is, once per frame however often this is called.
 */
export function refreshOrchPanel(): void {
  syncReportWatches()
  if (!panel || panel.hidden || renderPending) return
  renderPending = true
  requestAnimationFrame(() => {
    renderPending = false
    render()
    syncLive()
  })
}

function isOpen(): boolean {
  return panel !== null && !panel.hidden
}

function build(): void {
  if (!panel) return
  panel.replaceChildren()
  const header = document.createElement('div')
  header.className = 'git-panel-header'
  const title = document.createElement('span')
  title.className = 'git-panel-title'
  title.textContent = 'Orchestra'
  const actions = document.createElement('div')
  actions.className = 'git-panel-actions'
  const close = document.createElement('button')
  close.className = 'git-panel-btn git-panel-close'
  close.textContent = '×'
  close.title = 'Hide the Orchestra panel'
  close.addEventListener('click', toggleOrchPanel)
  actions.appendChild(close)
  header.append(title, actions)
  body = document.createElement('div')
  body.className = 'git-panel-body orch-panel-body'
  panel.append(header, body)
}

/**
 * The live parts run only while the panel is open: the card repaints, the
 * timeline, the elapsed-time tick, and reading workers' last lines.
 */
function syncLive(): void {
  const open = isOpen()
  if (open && unsubscribeSignal === null) {
    unsubscribeSignal = onCrewSignal((ids) => {
      for (const id of ids) cards.get(id)?.paint()
      for (const paint of headPainters) paint()
      for (const paint of reportPainters) paint()
    })
  } else if (!open && unsubscribeSignal !== null) {
    unsubscribeSignal()
    unsubscribeSignal = null
  }
  if (open && unsubscribeEvents === null) {
    unsubscribeEvents = crewEvents.listen(() => renderTimelineSoon())
  } else if (!open && unsubscribeEvents !== null) {
    unsubscribeEvents()
    unsubscribeEvents = null
  }
  const ticking = open && cards.size > 0
  if (ticking && ticker === null) {
    ticker = window.setInterval(() => {
      for (const card of cards.values()) card.paintElapsed()
      for (const paint of headPainters) paint() // the lead's "4m" too
    }, 1000)
  } else if (!ticking && ticker !== null) {
    window.clearInterval(ticker)
    ticker = null
  }
  setPanelReading(ticking)
}

// ---------- Crews ----------

interface PanelCrew {
  id: string
  hue: number
  lead: PaneNode | null
  tab: TabState
  workers: StripWorker[]
  /** Squad folders its members report into. Usually one; none for a crew made by hand. */
  squadDirs: string[]
}

/** Every crew in the window, in the order their first member appears. */
function panelCrews(): PanelCrew[] {
  const byId = new Map<string, PanelCrew>()
  for (const tab of state.tabs) {
    for (const node of paneNodes(tab.layout)) {
      const crew = node.crew
      if (!crew || !panes.has(node.id)) continue
      let entry = byId.get(crew.id)
      if (!entry) {
        entry = { id: crew.id, hue: crewHue(crew.id), lead: null, tab, workers: [], squadDirs: [] }
        byId.set(crew.id, entry)
      }
      if (crew.lead) {
        entry.lead = node
        entry.tab = tab
      } else {
        entry.workers.push({
          pane: node.id,
          handle: crew.handle,
          role: node.role?.id ?? null,
          agent: node.agent ?? null
        })
      }
      const dir = node.role?.squadDir
      if (dir && !entry.squadDirs.some((d) => pathKey(d) === pathKey(dir))) entry.squadDirs.push(dir)
    }
  }
  return [...byId.values()]
}

function render(): void {
  if (!body) return
  if (!isOpen()) {
    // Nothing on screen to keep: the cards go, and come back fresh on opening.
    for (const card of cards.values()) card.dispose()
    cards.clear()
    headPainters = []
    reportPainters = []
    timelineEl = null
    return
  }
  body.replaceChildren()
  headPainters = []
  reportPainters = []
  const crews = panelCrews()
  const used = new Set<string>()

  if (crews.length === 0) {
    body.appendChild(emptyState())
  } else {
    for (const crew of crews) body.appendChild(renderCrew(crew, used))
  }
  for (const [id, card] of cards) {
    if (used.has(id)) continue
    card.dispose()
    cards.delete(id)
  }

  timelineEl = document.createElement('div')
  timelineEl.className = 'orch-timeline'
  body.appendChild(timelineEl)
  renderTimeline()
}

function emptyState(): HTMLElement {
  const el = document.createElement('div')
  el.className = 'orch-empty'
  const text = document.createElement('p')
  text.textContent =
    'No orchestra is playing. An orchestra is one pane conducting others: it hands out the work, ' +
    'and you see every worker from here.'
  const start = document.createElement('button')
  start.className = 'orch-start'
  start.textContent = 'Start an orchestra'
  start.title = 'Open a squad: an orchestrator and the specialists it directs'
  start.addEventListener('click', () => void openSquad())
  const hint = document.createElement('p')
  hint.className = 'orch-hint'
  hint.textContent = 'Or pick “Conduct from Here” in any pane’s menu.'
  el.append(text, start, hint)
  return el
}

function renderCrew(crew: PanelCrew, used: Set<string>): HTMLElement {
  const el = document.createElement('section')
  el.className = 'orch-crew'
  el.style.setProperty('--crew-hue', String(crew.hue))

  const head = document.createElement('div')
  head.className = 'orch-crew-head'
  const dot = document.createElement('span')
  dot.className = 'crew-card-dot'
  const name = document.createElement('span')
  name.className = 'orch-crew-name'
  name.textContent = crew.lead ? `♪ ${panes.get(crew.lead.id)?.label() ?? 'orchestra'}` : '♪ orchestra'
  const where = document.createElement('span')
  where.className = 'orch-crew-tab'
  where.textContent = crew.tab.name
  head.append(dot, name, where)
  if (crew.lead) {
    const leadId = crew.lead.id
    head.classList.add('orch-clickable')
    head.title = 'Go to the lead'
    head.addEventListener('click', () => revealPane(leadId))
  } else {
    head.title = 'Its lead has gone; the workers are still linked to each other.'
  }

  const meta = document.createElement('div')
  meta.className = 'orch-crew-meta'
  const paintHead = (): void => {
    const ids = [crew.lead?.id, ...crew.workers.map((w) => w.pane)].filter(
      (id): id is string => id !== undefined
    )
    const worst = crewStatus(ids.map((id) => paneStatus.get(id)?.status))
    if (worst !== 'idle') dot.dataset['status'] = worst
    else delete dot.dataset['status']
    meta.textContent = leadText(crew)
  }
  paintHead()
  headPainters.push(paintHead)
  el.append(head, meta, renderSettings(crew))

  const list = document.createElement('div')
  list.className = 'orch-cards'
  for (const w of crew.workers) {
    let card = cards.get(w.pane)
    if (card) card.worker = w
    else {
      card = buildWorkerCard(w, crew.hue)
      cards.set(w.pane, card)
      readLastLine(w.pane)
    }
    card.paint()
    used.add(w.pane)
    list.appendChild(card.el)
  }
  if (crew.workers.length === 0) {
    const none = document.createElement('div')
    none.className = 'orch-none'
    none.textContent = 'No workers yet.'
    list.appendChild(none)
  }
  el.appendChild(list)

  const reports = renderReports(crew)
  if (reports) el.appendChild(reports)
  return el
}

/** One line on the lead: what it is doing, or why it is not. */
function leadText(crew: PanelCrew): string {
  const n = crew.workers.length
  const workers = `${n} worker${n === 1 ? '' : 's'}`
  const lead = crew.lead
  if (!lead) return `${workers} · no lead`
  const parts = [workers]
  if (state.crewSettings[crew.id]?.paused) parts.push('paused')
  const status = paneStatus.get(lead.id)
  if (panes.get(lead.id)?.exited) parts.push('lead exited')
  else if (!status && restoredQuiet.has(lead.id)) parts.push('restored, agent not running')
  else {
    const text = metaText(status?.status, paneUsage.get(lead.id))
    if (text) parts.push(`lead ${text}`)
    if (status?.lastActivity) parts.push(fmtElapsed(Date.now() - status.lastActivity))
  }
  return parts.join(' · ')
}

/**
 * What the person allows this crew. Each starts off, and the first of them is
 * asked about before it goes on: it lets an agent say yes to tool calls.
 */
function renderSettings(crew: PanelCrew): HTMLElement {
  const el = document.createElement('div')
  el.className = 'orch-settings'
  const settings = state.crewSettings[crew.id] ?? {}

  const box = (label: string, title: string, on: boolean, change: (on: boolean) => void): HTMLElement => {
    const row = document.createElement('label')
    row.className = 'orch-setting'
    row.title = title
    const input = document.createElement('input')
    input.type = 'checkbox'
    input.checked = on
    input.addEventListener('change', () => change(input.checked))
    const text = document.createElement('span')
    text.textContent = label
    row.append(input, text)
    return row
  }

  el.append(
    box(
      'Lead may approve',
      'Let the lead answer its own workers’ permission prompts with `lc approve`. Off: only you can.',
      settings.leadMayApprove === true,
      (on) => void setLeadMayApprove(crew, on)
    ),
    box(
      'Strict',
      'Refuse `lc` commands that reach outside this crew, and a worker driving its lead, instead of warning about them.',
      settings.strict === true,
      (on) => setCrewSetting(crew.id, 'strict', on)
    ),
    box(
      'Paused',
      'Hold the lead’s `lc` commands to this crew. The workers finish what they are doing, and the cards still work.',
      settings.paused === true,
      (on) => setCrewPaused(crew.id, on)
    )
  )
  return el
}

async function setLeadMayApprove(crew: PanelCrew, on: boolean): Promise<void> {
  if (on) {
    const lead = crew.lead ? (panes.get(crew.lead.id)?.label() ?? 'the lead') : 'the lead'
    const ok = await confirmDialog(
      `Let ${lead} answer its workers' permission prompts? It will be able to say yes to any tool a ` +
        'worker in this orchestra asks to run, edits, commands, all of it. You can untick this at any time.',
      'Allow'
    )
    if (!ok) {
      refreshOrchPanel() // put the box back the way it was
      return
    }
  }
  setCrewSetting(crew.id, 'leadMayApprove', on)
}

// ---------- Timeline ----------

function renderTimelineSoon(): void {
  if (timelinePending) return
  timelinePending = true
  requestAnimationFrame(() => {
    timelinePending = false
    renderTimeline()
  })
}

function renderTimeline(): void {
  const el = timelineEl
  if (!el || !isOpen()) return
  el.replaceChildren()
  const events = crewEvents.recent(TIMELINE_LENGTH)
  if (events.length === 0) return
  const title = document.createElement('div')
  title.className = 'git-section-header orch-section'
  title.textContent = 'Recent'
  el.appendChild(title)
  // Newest first: the question is "what just happened".
  for (const event of [...events].reverse()) el.appendChild(timelineRow(event))
}

function timelineRow(e: CrewEvent): HTMLElement {
  const row = document.createElement('div')
  row.className = 'orch-event'
  row.style.setProperty('--crew-hue', String(crewHue(e.crew)))
  const when = document.createElement('span')
  when.className = 'orch-event-time'
  when.textContent = new Date(e.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  const who = document.createElement('span')
  who.className = 'orch-event-who'
  who.textContent = `@${e.handle}`
  const what = document.createElement('span')
  what.className = 'orch-event-what'
  what.textContent = eventText(e)
  row.append(when, who, what)
  row.title = [`#${e.seq}`, e.detail ?? ''].filter(Boolean).join(' · ')
  if (panes.has(e.pane)) {
    row.classList.add('orch-clickable')
    row.addEventListener('click', () => revealPane(e.pane))
  }
  return row
}

// ---------- Reports ----------

/** Watched squad folders: their spelling as a pane carries it, by pathKey. */
const watched = new Map<string, string>()
/** What each watched folder's reports/ holds, by pathKey. */
const reportsOf = new Map<string, SquadReportFile[]>()
let unsubscribeReports: (() => void) | null = null

/**
 * One spelling for a folder, so a report pushed for one crew's spelling of its
 * squad folder finds the panes that spell it another way.
 */
function pathKey(p: string): string {
  const slashed = p.split('\\').join('/').replace(/\/+$/, '')
  return window.lightclaude.platform === 'linux' ? slashed : slashed.toLowerCase()
}

/**
 * Watch the reports of every squad folder a crew member reports into, and
 * stop watching the ones none does any more. A window with no crew watches
 * nothing and asks main for nothing.
 */
function syncReportWatches(): void {
  const want = new Map<string, string>()
  for (const tab of state.tabs) {
    for (const node of paneNodes(tab.layout)) {
      const dir = node.role?.squadDir
      if (node.crew && dir) want.set(pathKey(dir), dir)
    }
  }
  for (const [key, dir] of watched) {
    if (want.has(key)) continue
    watched.delete(key)
    reportsOf.delete(key)
    window.lightclaude.squad.unwatch(dir)
  }
  for (const [key, dir] of want) {
    if (watched.has(key)) continue
    watched.set(key, dir)
    void window.lightclaude.squad.watch(dir).then(
      (list) => {
        if (watched.get(key) !== dir) return // let go of while main was answering
        reportsOf.set(key, list ?? [])
        if ((list ?? []).length > 0) refreshOrchPanel()
      },
      () => {}
    )
  }
  if (watched.size > 0 && unsubscribeReports === null) {
    unsubscribeReports = window.lightclaude.squad.onReport(onReport)
  } else if (watched.size === 0 && unsubscribeReports !== null) {
    unsubscribeReports()
    unsubscribeReports = null
  }
}

/** The crew members a report in this folder is from: by role id, or by handle. */
function authorsOf(key: string, name: string): PaneNode[] {
  const stem = name.replace(/\.md$/, '')
  const out: PaneNode[] = []
  for (const tab of state.tabs) {
    for (const node of paneNodes(tab.layout)) {
      const dir = node.role?.squadDir
      if (!node.crew || !dir || pathKey(dir) !== key) continue
      if (node.role?.id === stem || node.crew.handle === stem) out.push(node)
    }
  }
  return out
}

/**
 * A report landed or was rewritten: light its author's card, and tell the
 * lead through `lc events` — the thing it is waiting on, more often than not.
 */
function onReport(update: SquadReportUpdate): void {
  const key = pathKey(update.squadDir)
  if (!watched.has(key)) return
  reportsOf.set(key, update.reports)
  for (const name of update.changed) {
    for (const node of authorsOf(key, name)) {
      reportLanded.add(node.id)
      crewEvent(node.id, 'reported', { detail: name })
      crewSignal(node.id)
    }
  }
  refreshOrchPanel()
}

function renderReports(crew: PanelCrew): HTMLElement | null {
  const rows: { dir: string; file: SquadReportFile }[] = []
  for (const dir of crew.squadDirs) {
    for (const file of reportsOf.get(pathKey(dir)) ?? []) rows.push({ dir, file })
  }
  if (rows.length === 0) return null
  const el = document.createElement('div')
  el.className = 'orch-reports'
  const now = Date.now()
  for (const { dir, file } of rows) {
    const row = document.createElement('div')
    row.className = 'orch-report orch-clickable'
    const dot = document.createElement('span')
    dot.className = 'crew-card-report'
    const paintDot = (): void => {
      dot.hidden = !authorsOf(pathKey(dir), file.name).some((n) => reportLanded.has(n.id))
    }
    paintDot()
    reportPainters.push(paintDot)
    const name = document.createElement('span')
    name.className = 'orch-report-name'
    name.textContent = file.name
    const when = document.createElement('span')
    when.className = 'orch-report-time'
    when.textContent = `${fmtElapsed(now - file.mtime)} ago`
    row.append(dot, name, when)
    row.title = `Read ${file.name}`
    row.addEventListener('click', () => void openReport(dir, file.name))
    el.appendChild(row)
  }
  return el
}

/**
 * Show a report, as it was written — preformatted text, not rendered. Opening
 * it is looking at it, so its author's report dot goes out.
 */
export async function openReport(squadDir: string, name: string): Promise<void> {
  const got = await window.lightclaude.squad.readReport(squadDir, name)
  for (const node of authorsOf(pathKey(squadDir), name)) {
    if (reportLanded.delete(node.id)) crewSignal(node.id)
  }
  refreshOrchPanel()

  const overlay = document.createElement('div')
  overlay.id = 'shortcuts-overlay'
  const modal = document.createElement('div')
  modal.className = 'shortcuts-modal report-modal'
  const header = document.createElement('div')
  header.className = 'report-header'
  const title = document.createElement('span')
  title.className = 'report-title'
  title.textContent = name
  const where = document.createElement('span')
  where.className = 'report-where'
  where.textContent = squadDir
  where.title = squadDir
  header.append(title, where)

  const text = document.createElement('pre')
  text.className = 'report-text'
  text.textContent =
    got === null ? 'This report could not be read, it may have been moved or deleted since.' : got.text
  modal.append(header, text)
  if (got?.truncated) {
    const note = document.createElement('div')
    note.className = 'report-note'
    note.textContent = 'Only the first 256 KB is shown. The whole file is in the squad folder.'
    modal.appendChild(note)
  }

  const footer = document.createElement('div')
  footer.className = 'shortcuts-footer confirm-actions'
  const close = document.createElement('button')
  close.className = 'shortcuts-primary'
  close.textContent = 'Close'
  footer.appendChild(close)
  modal.appendChild(footer)
  overlay.appendChild(modal)

  const finish = (): void => {
    document.removeEventListener('keydown', onKeydown, { capture: true })
    overlay.remove()
    if (state.focusedPaneId) panes.get(state.focusedPaneId)?.focus()
  }
  const onKeydown = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape') return
    e.stopPropagation()
    finish()
  }
  close.addEventListener('click', finish)
  overlay.addEventListener('pointerdown', (e) => {
    if (e.target === overlay) finish()
  })
  document.addEventListener('keydown', onKeydown, { capture: true })
  document.body.appendChild(overlay)
  close.focus()
}
