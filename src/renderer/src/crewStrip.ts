import {
  babysitterCapped,
  babysitterCount,
  isBabysitterOn,
  onBabysitterChange,
  toggleBabysitter
} from './babysitter'
import { confirmDialog } from './confirmDialog'
import { fmtElapsed } from './missionControl'
import { steer } from './steer'
import type { SteerAction } from './steer'
import { lastOutputAt, lastSent, paneLastLine, paneStatus, reportLanded, restoredQuiet } from './store'
import { AGENTS } from '../../shared/agents'
import { crewStatus } from '../../shared/crew'
import type { PaneStatus } from '../../shared/ipc'
import { toast } from './ui/toast'

/**
 * The worker strip: an orchestra lead's view of the panes it drives, docked
 * inside the lead pane itself between its header and its terminal.
 *
 * One card per worker — what it is doing, the last thing on its screen, what
 * was last typed into it — and the few things a person conducting needs to do
 * without leaving the lead: answer a permission prompt, stop a turn, send a
 * line, arm the babysitter. Every one of those goes through steer(), the path
 * `lc` itself takes, so a button can never do what the gate would refuse an
 * agent or skip what the gate would say.
 *
 * Only a lead gets a strip, so a window with no orchestra never builds one,
 * never starts a timer, and never reads a line of anybody's screen.
 */

export interface StripWorker {
  pane: string
  handle: string
  /** Squad role id, if the worker holds one. */
  role: string | null
  /** The agent named for the pane, if any. Shown only when it is not claude. */
  agent: string | null
}

export interface StripCrew {
  lead: string
  crewId: string
  hue: number
  collapsed: boolean
  /** The person has taken the baton back: the lead's `lc` commands are held. */
  paused: boolean
  workers: StripWorker[]
}

/** What the strip needs from the app. The app owns the panes; this only shows them. */
export interface StripHooks {
  /** Dock `el` into the lead pane, or take the strip out (null). */
  mount(leadId: string, el: HTMLElement | null): void
  /** The approval badge on the lead's header. */
  setAlert(leadId: string, count: number, detail: string): void
  roleBadge(paneId: string): string | null
  drivenTimes(paneId: string): number
  lastLine(paneId: string): string | null
  exited(paneId: string): boolean
  focus(paneId: string): void
  addWorker(leadId: string): void
  setCollapsed(leadId: string, collapsed: boolean): void
  setPaused(crewId: string, paused: boolean): void
  /** Something a strip shows moved; the link lines follow the same signal. */
  afterSignal(): void
}

const STATUS_TEXT: Record<PaneStatus, string> = {
  working: 'working',
  'waiting-input': 'waiting',
  'waiting-approval': 'needs approval',
  idle: 'idle'
}

/**
 * How often a busy worker's last line is re-read. An agent mid-turn redraws its
 * spinner many times a second; the card needs a line, not an animation, and
 * reading the buffer per chunk would spend the renderer on something nobody
 * can read that fast anyway.
 */
const LINE_THROTTLE_MS = 750

let hooks: StripHooks | null = null
const strips = new Map<string, CrewStrip>() // lead pane id -> strip
const leadOf = new Map<string, string>() // worker pane id -> its lead's pane id
const lineTimers = new Map<string, number>()
const dirty = new Set<string>() // leads whose strip needs a repaint
let flushPending = false
let ticker: number | null = null
let unsubscribeBaby: (() => void) | null = null
/**
 * Whoever else shows worker cards — the Orchestra panel, while it is open.
 * Told which panes were signalled, once per frame. Empty, crewSignal costs
 * what it always did.
 */
const signalWatchers = new Set<(paneIds: ReadonlySet<string>) => void>()
const signalled = new Set<string>()
/** The panel is open and showing cards, so last lines are worth reading. */
let panelReading = false

/**
 * Bring the strips into line with the crews: one per lead, cards for its
 * workers. Called whenever membership may have changed (app.renderCrews).
 */
export function syncStrips(crews: StripCrew[], h: StripHooks): void {
  hooks = h
  const keep = new Set(crews.map((c) => c.lead))
  for (const [lead, strip] of strips) {
    if (keep.has(lead)) continue
    strip.dispose()
    strips.delete(lead)
    h.mount(lead, null)
    h.setAlert(lead, 0, '')
  }
  leadOf.clear()
  for (const crew of crews) {
    let strip = strips.get(crew.lead)
    if (!strip) {
      strip = new CrewStrip(crew.lead)
      strips.set(crew.lead, strip)
    }
    strip.set(crew)
    h.mount(crew.lead, strip.el)
    for (const w of crew.workers) leadOf.set(w.pane, crew.lead)
  }
  for (const [pane, timer] of lineTimers) {
    if (leadOf.has(pane)) continue
    window.clearTimeout(timer)
    lineTimers.delete(pane)
  }
  for (const strip of strips.values()) {
    strip.readLines()
    strip.paint()
  }
  syncTicker()
}

/**
 * Something about a pane changed — its status, its shell, what was typed into
 * it. Repaints the strip it shows up in, once per frame however many arrive.
 * A pane in no strip costs one map lookup.
 */
export function crewSignal(paneId: string): void {
  const lead = strips.has(paneId) ? paneId : leadOf.get(paneId)
  if (lead !== undefined) dirty.add(lead)
  else if (signalWatchers.size === 0) return
  if (signalWatchers.size > 0) signalled.add(paneId)
  if (flushPending) return
  flushPending = true
  requestAnimationFrame(() => {
    flushPending = false
    for (const id of dirty) strips.get(id)?.paint()
    dirty.clear()
    hooks?.afterSignal()
    if (signalled.size === 0) return
    const ids = new Set(signalled)
    signalled.clear()
    for (const watcher of [...signalWatchers]) watcher(ids)
  })
}

/** Hear about crewSignal, once per frame, with the panes it named. Returns the unsubscribe. */
export function onCrewSignal(watcher: (paneIds: ReadonlySet<string>) => void): () => void {
  signalWatchers.add(watcher)
  return () => signalWatchers.delete(watcher)
}

/**
 * The Orchestra panel is showing cards (or stopped). While it is, a worker's
 * last line is read even when its lead's strip is folded or in another tab.
 */
export function setPanelReading(on: boolean): void {
  panelReading = on
}

/** Re-read one worker's last line. True when it changed. */
export function readLastLine(paneId: string): boolean {
  const line = hooks?.lastLine(paneId) ?? null
  if (line === null || paneLastLine.get(paneId) === line) return false
  paneLastLine.set(paneId, line)
  return true
}

/**
 * A pane printed something. Called for every chunk of every pane's output, so
 * a pane that is not a worker returns before doing anything at all; a worker's
 * last line is re-read at most every LINE_THROTTLE_MS, and only while its
 * card is actually on screen.
 */
export function noteCrewOutput(paneId: string): void {
  const lead = leadOf.get(paneId)
  if (lead === undefined) return
  lastOutputAt.set(paneId, Date.now())
  if (lineTimers.has(paneId)) return
  lineTimers.set(
    paneId,
    window.setTimeout(() => {
      lineTimers.delete(paneId)
      const strip = strips.get(lead)
      const onStrip = strip?.visible() === true
      if ((!onStrip && !panelReading) || !hooks) return
      if (!readLastLine(paneId)) return
      if (onStrip) strip?.paintCard(paneId)
      if (panelReading) {
        for (const watcher of [...signalWatchers]) watcher(new Set([paneId]))
      }
    }, LINE_THROTTLE_MS)
  )
}

/** Re-read every visible card's last line — after a tab switch, say. */
export function refreshStrips(): void {
  for (const strip of strips.values()) {
    if (!strip.visible()) continue
    strip.readLines()
    strip.paint()
  }
}

/** The elapsed times tick only while some strip is open; none open, no timer. */
function syncTicker(): void {
  const want = [...strips.values()].some((s) => !s.collapsed)
  if (want && ticker === null) {
    ticker = window.setInterval(() => {
      for (const strip of strips.values()) if (strip.visible()) strip.paintElapsed()
    }, 1000)
  } else if (!want && ticker !== null) {
    window.clearInterval(ticker)
    ticker = null
  }
  // The babysitter button on each card mirrors the sitter, which changes from
  // the pane menu and Mission Control as well as from here.
  if (strips.size > 0 && unsubscribeBaby === null) {
    unsubscribeBaby = onBabysitterChange(() => {
      for (const lead of strips.keys()) crewSignal(lead)
    })
  } else if (strips.size === 0 && unsubscribeBaby !== null) {
    unsubscribeBaby()
    unsubscribeBaby = null
  }
}

/**
 * Act on a worker through steer(), and say so on the card if it could not be
 * done — the prompt answered by hand a moment ago, the shell gone.
 */
async function act(card: Card, action: SteerAction): Promise<boolean> {
  const res = await steer(card.worker.pane, action, { via: 'human' })
  if (!res.ok) card.note(res.error)
  return res.ok
}

/** One worker's card: what the strip shows, and the Orchestra panel too. */
export interface WorkerCard {
  readonly el: HTMLElement
  worker: StripWorker
  paint(): void
  paintElapsed(): void
  dispose(): void
}

/**
 * A worker card on its own, for somewhere other than a lead's strip — the
 * Orchestra panel. The same card, the same buttons, the same steer() path.
 */
export function buildWorkerCard(worker: StripWorker, hue: number): WorkerCard {
  const card = new Card(worker)
  card.el.style.setProperty('--crew-hue', String(hue))
  return card
}

class Card implements WorkerCard {
  readonly el: HTMLElement
  private dot: HTMLElement
  private name: HTMLElement
  private agentEl: HTMLElement
  private stateEl: HTMLElement
  private elapsedEl: HTMLElement
  private lcEl: HTMLElement
  private reportEl: HTMLElement
  private lineEl: HTMLElement
  private sentEl: HTMLElement
  private noteEl: HTMLElement
  private roleNoteEl: HTMLElement
  private approveBtn: HTMLButtonElement
  private denyBtn: HTMLButtonElement
  private stopBtn: HTMLButtonElement
  private babyBtn: HTMLButtonElement
  private input: HTMLInputElement
  private noteTimer: number | null = null

  constructor(public worker: StripWorker) {
    const mk = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string): HTMLElementTagNameMap[K] => {
      const el = document.createElement(tag)
      el.className = cls
      return el
    }
    this.el = mk('div', 'crew-card')
    const top = mk('div', 'crew-card-top')
    this.dot = mk('span', 'crew-card-dot')
    this.name = mk('span', 'crew-card-name')
    this.agentEl = mk('span', 'crew-card-agent')
    this.stateEl = mk('span', 'crew-card-state')
    this.elapsedEl = mk('span', 'crew-card-elapsed')
    this.lcEl = mk('span', 'crew-card-lc')
    this.reportEl = mk('span', 'crew-card-report')
    this.reportEl.title = 'A report has landed'
    top.append(this.dot, this.name, this.agentEl, this.stateEl, this.elapsedEl, this.lcEl, this.reportEl)

    this.lineEl = mk('div', 'crew-card-line')
    this.sentEl = mk('div', 'crew-card-sent')
    this.noteEl = mk('div', 'crew-card-note')
    this.noteEl.hidden = true
    this.roleNoteEl = mk('div', 'crew-card-rolenote')
    this.roleNoteEl.hidden = true

    const actions = mk('div', 'crew-card-actions')
    const button = (label: string, title: string, onClick: () => void): HTMLButtonElement => {
      const b = mk('button', 'crew-card-btn')
      b.textContent = label
      b.title = title
      b.addEventListener('click', (e) => {
        e.stopPropagation()
        onClick()
      })
      return b
    }
    this.approveBtn = button('Approve', 'Answer the permission prompt with yes', () => {
      void act(this, { kind: 'approve' })
    })
    this.approveBtn.classList.add('crew-card-approve')
    this.denyBtn = button('Deny', 'Answer the permission prompt with no', () => {
      void act(this, { kind: 'deny' })
    })
    this.stopBtn = button('Stop', 'Interrupt the turn it is in the middle of', () => {
      void this.interrupt()
    })
    this.babyBtn = button('🤖', '', () => {
      toggleBabysitter(this.worker.pane)
    })
    this.input = mk('input', 'crew-card-input')
    this.input.spellcheck = false
    this.input.addEventListener('keydown', (e) => {
      // keys.ts already stands aside for an input; this keeps Enter and Escape
      // from reaching anything behind the card.
      e.stopPropagation()
      if (e.key === 'Enter') void this.send()
      else if (e.key === 'Escape') this.input.blur()
    })
    actions.append(this.approveBtn, this.denyBtn, this.stopBtn, this.babyBtn, this.input)

    this.el.append(top, this.lineEl, this.sentEl, this.roleNoteEl, this.noteEl, actions)
    this.el.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('button, input')) return
      if (reportLanded.delete(this.worker.pane)) crewSignal(this.worker.pane)
      hooks?.focus(this.worker.pane)
    })
  }

  private async interrupt(): Promise<void> {
    const ok = await confirmDialog(
      `Interrupt @${this.worker.handle}? It stops the turn it is in the middle of; the session itself keeps running.`,
      'Interrupt'
    )
    if (ok) await act(this, { kind: 'interrupt' })
  }

  private async send(): Promise<void> {
    const text = this.input.value
    if (text.trim() === '') return
    let force = false
    // The gate refuses this for an agent outright. A person gets asked instead:
    // answering the prompt by typing may be exactly what they mean.
    if (paneStatus.get(this.worker.pane)?.status === 'waiting-approval') {
      force = await confirmDialog(
        `@${this.worker.handle} is showing a permission prompt, so this text would answer it ` +
          'rather than reach the agent. Send it anyway?',
        'Send anyway'
      )
      if (!force) return
    }
    if (await act(this, { kind: 'send', text, enter: true, force })) this.input.value = ''
    this.input.focus()
  }

  /** Show why something could not be done, for a few seconds. */
  note(text: string): void {
    this.noteEl.hidden = false
    this.noteEl.textContent = text
    if (this.noteTimer !== null) window.clearTimeout(this.noteTimer)
    this.noteTimer = window.setTimeout(() => {
      this.noteTimer = null
      this.noteEl.hidden = true
    }, 5000)
  }

  paint(): void {
    const id = this.worker.pane
    const status = paneStatus.get(id)
    const exited = hooks?.exited(id) ?? false
    const s = status?.status
    this.el.dataset['status'] = exited ? 'exited' : (s ?? 'none')
    if (s && s !== 'idle') this.dot.dataset['status'] = s
    else delete this.dot.dataset['status']

    const emoji = hooks?.roleBadge(id)
    this.name.textContent = `${emoji ? `${emoji} ` : ''}@${this.worker.handle}`
    this.agentEl.hidden = !this.worker.agent || this.worker.agent === 'claude'
    this.agentEl.textContent = this.worker.agent ?? ''
    // An agent with no wrapper was told its role once, in its first message.
    const adapter = this.worker.agent ? AGENTS[this.worker.agent] : undefined
    const roleOnce = this.worker.role !== null && adapter?.rolePromptVia === 'first-message' && adapter.bin !== ''
    this.roleNoteEl.hidden = !roleOnce
    if (roleOnce) {
      this.roleNoteEl.textContent = 'role given in its first message, /clear forgets it'
      this.roleNoteEl.title =
        `${adapter.label} has no wrapper to re-apply the role at every launch, so it was told it once.`
    }
    const estimated = status?.source === 'heuristic'
    const restored = !exited && !status && restoredQuiet.has(id)
    if (restored) this.el.dataset['status'] = 'restored'
    this.stateEl.textContent = exited
      ? 'exited'
      : restored
        ? 'restored, agent not running'
        : !status
          ? 'no agent'
          : (estimated ? '≈ ' : '') +
            (s === 'working' && status.lastTool ? status.lastTool.toLowerCase() : STATUS_TEXT[status.status])
    this.stateEl.title = restored
      ? 'The app was restarted: this pane has a fresh shell and nothing has been started in it yet.'
      : estimated
        ? 'Estimated from the terminal going quiet; this agent does not report its own status.'
        : ''
    this.paintElapsed()

    const driven = hooks?.drivenTimes(id) ?? 0
    this.lcEl.hidden = driven === 0
    this.lcEl.textContent = `lc ${driven}`
    this.lcEl.title = `${driven} command${driven === 1 ? '' : 's'} sent by the agent CLI`
    this.reportEl.hidden = !reportLanded.has(id)

    const line = paneLastLine.get(id)
    this.lineEl.textContent = line ?? ''
    this.lineEl.hidden = line === undefined
    const sent = lastSent.get(id)
    this.sentEl.hidden = sent === undefined
    if (sent) {
      this.sentEl.textContent = `${sent.by} → ${sent.text.replace(/\s+/g, ' ')}`
      this.sentEl.title = sent.text
    }

    const asking = s === 'waiting-approval' && !exited && !estimated
    this.approveBtn.hidden = !asking
    this.denyBtn.hidden = !asking
    this.stopBtn.hidden = s !== 'working' || exited
    this.input.disabled = exited
    this.input.placeholder = `Message @${this.worker.handle}…`

    const on = isBabysitterOn(id)
    const count = babysitterCount(id)
    this.babyBtn.classList.toggle('on', on)
    this.babyBtn.textContent = on && count > 0 ? `🤖 ${count}` : '🤖'
    this.babyBtn.title = on
      ? babysitterCapped(id)
        ? 'Babysitter paused, nudge limit reached; type in the pane to resume'
        : 'Auto-continue ON, click to disable'
      : 'Auto-continue OFF, click to keep the agent going when it finishes'
    // It never types on a guess, so say so where the guess is all there is.
    if (estimated) this.babyBtn.title += ' (never acts on an estimated ≈ status)'
  }

  paintElapsed(): void {
    // Whichever is later: a hook status, or the pane printing something. A
    // worker with no hooks — a plain shell, or claude before its first event —
    // still shows how long since it last did anything.
    const at = Math.max(
      paneStatus.get(this.worker.pane)?.lastActivity ?? 0,
      lastOutputAt.get(this.worker.pane) ?? 0
    )
    this.elapsedEl.textContent = at > 0 ? fmtElapsed(Date.now() - at) : ''
  }

  dispose(): void {
    if (this.noteTimer !== null) window.clearTimeout(this.noteTimer)
    this.el.remove()
  }
}

class CrewStrip {
  readonly el: HTMLElement
  collapsed = false
  private crew: StripCrew | null = null
  private headDot: HTMLElement
  private summary: HTMLElement
  private toggleBtn: HTMLButtonElement
  private pauseBtn: HTMLButtonElement
  private cardsEl: HTMLElement
  private empty: HTMLElement
  private cards = new Map<string, Card>()

  constructor(readonly lead: string) {
    this.el = document.createElement('div')
    this.el.className = 'crew-strip'

    const head = document.createElement('div')
    head.className = 'crew-strip-head'
    this.headDot = document.createElement('span')
    this.headDot.className = 'crew-card-dot'
    const title = document.createElement('span')
    title.className = 'crew-strip-title'
    title.textContent = '♪ Orchestra'
    this.summary = document.createElement('span')
    this.summary.className = 'crew-strip-summary'
    const gap = document.createElement('span')
    gap.className = 'crew-strip-gap'
    const add = document.createElement('button')
    add.className = 'crew-strip-btn'
    add.textContent = '+ worker'
    add.title = 'Open a new worker beside this orchestra'
    add.addEventListener('click', (e) => {
      e.stopPropagation()
      hooks?.addWorker(this.lead)
    })
    // Pausing is for the moment the lead is heading somewhere it should not:
    // its commands to the crew stop going through, the workers carry on with
    // whatever they were already doing, and the cards still answer to a person.
    this.pauseBtn = document.createElement('button')
    this.pauseBtn.className = 'crew-strip-btn crew-strip-pause'
    this.pauseBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      if (this.crew) hooks?.setPaused(this.crew.crewId, !this.crew.paused)
    })
    this.toggleBtn = document.createElement('button')
    this.toggleBtn.className = 'crew-strip-btn crew-strip-toggle'
    this.toggleBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      hooks?.setCollapsed(this.lead, !this.collapsed)
    })
    head.append(this.headDot, title, this.summary, gap, this.pauseBtn, add, this.toggleBtn)

    this.cardsEl = document.createElement('div')
    this.cardsEl.className = 'crew-strip-cards'
    this.empty = document.createElement('div')
    this.empty.className = 'crew-strip-empty'
    this.empty.textContent = 'No workers yet. “+ worker” opens one beside this pane.'
    this.el.append(head, this.cardsEl)
  }

  set(crew: StripCrew): void {
    this.crew = crew
    this.collapsed = crew.collapsed
    this.el.style.setProperty('--crew-hue', String(crew.hue))
    this.el.classList.toggle('collapsed', crew.collapsed)
    this.el.classList.toggle('paused', crew.paused)
    this.pauseBtn.textContent = crew.paused ? '▶ resume' : '❚❚ pause'
    this.pauseBtn.title = crew.paused
      ? "Hand the baton back: the lead's lc commands go through again"
      : "Hold the lead's lc commands to this crew. The workers finish what they are doing, and these cards still work."
    this.toggleBtn.textContent = crew.collapsed ? '▸' : '▾'
    this.toggleBtn.title = crew.collapsed ? 'Show the worker cards' : 'Fold the strip to one line'
    const ids = new Set(crew.workers.map((w) => w.pane))
    for (const [id, card] of this.cards) {
      if (ids.has(id)) continue
      card.dispose()
      this.cards.delete(id)
    }
    // Rebuilt in crew order each time, reusing cards so a half-typed message
    // in a send box survives somebody else joining the crew.
    this.cardsEl.textContent = ''
    for (const w of crew.workers) {
      let card = this.cards.get(w.pane)
      if (card) card.worker = w
      else {
        card = new Card(w)
        this.cards.set(w.pane, card)
      }
      this.cardsEl.appendChild(card.el)
    }
    if (crew.workers.length === 0) this.cardsEl.appendChild(this.empty)
  }

  /** On screen and unfolded: the lead's tab is showing and nothing hides it. */
  visible(): boolean {
    return !this.collapsed && this.el.isConnected && this.el.offsetParent !== null
  }

  readLines(): void {
    if (!this.visible()) return
    for (const id of this.cards.keys()) readLastLine(id)
  }

  paintCard(paneId: string): void {
    this.cards.get(paneId)?.paint()
  }

  paintElapsed(): void {
    for (const card of this.cards.values()) card.paintElapsed()
  }

  paint(): void {
    const crew = this.crew
    if (!crew) return
    const statuses = crew.workers.map((w) => paneStatus.get(w.pane)?.status)
    const worst = crewStatus(statuses)
    if (worst !== 'idle') this.headDot.dataset['status'] = worst
    else delete this.headDot.dataset['status']

    const count = (s: PaneStatus): number => statuses.filter((x) => x === s).length
    const parts: string[] = [`${crew.workers.length} worker${crew.workers.length === 1 ? '' : 's'}`]
    if (crew.paused) parts.unshift('paused')
    const asking = count('waiting-approval')
    if (asking > 0) parts.push(`${asking} needs approval`)
    if (count('working') > 0) parts.push(`${count('working')} working`)
    if (count('waiting-input') > 0) parts.push(`${count('waiting-input')} waiting`)
    this.summary.textContent = parts.join(' · ')

    const askingHandles = crew.workers
      .filter((w) => paneStatus.get(w.pane)?.status === 'waiting-approval')
      .map((w) => `@${w.handle}`)
    hooks?.setAlert(
      this.lead,
      asking,
      asking > 0 ? `Waiting on a permission prompt: ${askingHandles.join(', ')}. Click to go to the first.` : ''
    )

    for (const card of this.cards.values()) card.paint()
  }

  dispose(): void {
    for (const card of this.cards.values()) card.dispose()
    this.cards.clear()
    this.el.remove()
  }
}

/** Ask once a session before a shortcut answers somebody's permission prompt. */
let approveKeyConfirmed = false

/**
 * Mod+Shift+Y: say yes to the permission prompt the focused crew is stuck on.
 *
 * The focused pane's own prompt if it has one, otherwise the first crew-mate
 * in reading order that is asking. Outside a crew, or with nobody asking, it
 * does nothing — quietly, as Mod+Shift+J does with nothing to jump to.
 *
 * The first use in a session asks first and names what is being approved:
 * a key that says yes to a tool call is not one to learn by accident.
 */
export async function approveFromKey(candidates: StripWorker[]): Promise<void> {
  const target = candidates.find((w) => paneStatus.get(w.pane)?.status === 'waiting-approval')
  if (!target) return
  if (!approveKeyConfirmed) {
    const tool = paneStatus.get(target.pane)?.lastTool
    const ok = await confirmDialog(
      `Approve @${target.handle}'s permission prompt${tool ? ` (${tool})` : ''}? ` +
        'The shortcut answers yes to the first worker in this orchestra that is asking. ' +
        'It will not ask again this session.',
      'Approve'
    )
    if (!ok) return
    approveKeyConfirmed = true
  }
  const res = await steer(target.pane, { kind: 'approve' }, { via: 'human' })
  if (!res.ok) toast({ tone: 'error', title: 'Could not approve', detail: res.error })
}
