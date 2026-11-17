import type { PaneStatus, StatusUpdate, UsageUpdate } from '../../shared/ipc'
import type { CrewSettings, PersistedState, TabState } from '../../shared/types'

/**
 * Terminal font size, in px, shared by every pane.
 *
 * One size for all panes rather than per-pane: the reason to change it is
 * almost always "this layout got dense, fit more in", which applies to the
 * whole grid at once.
 */
export const FONT_SIZE_DEFAULT = 14
export const FONT_SIZE_MIN = 8
export const FONT_SIZE_MAX = 32

export function clampFontSize(px: number): number {
  return Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, Math.round(px)))
}

export interface AppState {
  tabs: TabState[]
  activeTabId: string | null
  focusedPaneId: string | null
  fontSize: number
  /** The git tree panel is docked open. Closed until asked for, and remembered. */
  gitPanelOpen: boolean
  /** The panel fetches from the remote every few minutes while it is open. */
  gitAutoFetch: boolean
  /** The Orchestra panel is docked open. Closed until asked for, and remembered. */
  orchPanelOpen: boolean
  /** What the person has allowed each crew, by crew id. Empty for most people. */
  crewSettings: Record<string, CrewSettings>
}

export const state: AppState = {
  tabs: [],
  activeTabId: null,
  focusedPaneId: null,
  fontSize: FONT_SIZE_DEFAULT,
  gitPanelOpen: false,
  gitAutoFetch: true,
  orchPanelOpen: false,
  crewSettings: {}
}

/** Latest Claude activity state per pane (ephemeral — never persisted). */
export const paneStatus = new Map<string, StatusUpdate>()

/**
 * Commands waiting for their pane's first shell prompt.
 *
 * A freshly spawned shell is not ready to be typed into — it is still sourcing
 * rc files — and guessing how long that takes is the class of bug this app keeps
 * removing. The prompt hook already reports the exact moment a prompt is drawn,
 * so a command sits here until then. Consumed once, by setPaneCwd.
 */
export const pendingCommand = new Map<string, string>()

/**
 * Panes where an agent has been asked for but has not reported yet.
 *
 * A fan-out queues `claude` and returns; the agent needs a second or two more
 * before its first hook arrives and the pane gains a status. In that window
 * `lc wait --for idle` used to refuse the pane outright — "no agent is running"
 * — which broke the documented fan-then-wait sequence for anyone quick enough
 * to run it back to back. Knowing that we asked is the honest difference
 * between "there is no agent here" and "there is not one yet".
 */
export const expectingAgent = new Set<string>()

/**
 * Told whenever a pane's state may have moved: a status report, its shell
 * exiting, the pane closing. Called with the pane id and nothing else — a
 * listener reads whatever it cares about from the maps above.
 *
 * This is what `lc wait` waits on. It used to poll every 250ms because status
 * arrives by several routes and a poll cannot miss one; the routes all pass
 * through the few places that call notifyStatus now, and the wait keeps a slow
 * poll anyway as a net for a route somebody adds later and forgets to wire.
 */
export const statusListeners = new Set<(paneId: string) => void>()

export function notifyStatus(paneId: string): void {
  // Copied: a listener that settles a wait removes itself while this runs.
  for (const listener of [...statusListeners]) listener(paneId)
}

/** Latest token usage per pane (ephemeral — mirrors what the badge shows). */
export const paneUsage = new Map<string, UsageUpdate>()

/*
 * What an orchestra's worker cards show beyond status. Ephemeral, and kept only
 * for panes in a crew: nothing writes here for a plain pane. Every entry has to
 * go when its pane does — see forgetCrewSignals, which closePane, closeTab and
 * applyLayout's dropped panes all call.
 */

/** When each crew member last printed anything (ms). */
export const lastOutputAt = new Map<string, number>()

/** The last line on each crew member's screen that says something. */
export const paneLastLine = new Map<string, string>()

/** The last text typed into each crew member from outside it, and by whom. */
export const lastSent = new Map<string, { text: string; at: number; by: string }>()

/** Crew members with a report filed that nobody has looked at yet. */
export const reportLanded = new Set<string>()

/**
 * Crew members brought back by a restart and silent since. A restart gives
 * every pane a fresh shell and starts no agent in it, so the card says so
 * ("restored — agent not running") rather than "no agent", which would read
 * as though the worker had never had one. Cleared by the pane's first status.
 */
export const restoredQuiet = new Set<string>()

export function forgetCrewSignals(paneId: string): void {
  lastOutputAt.delete(paneId)
  paneLastLine.delete(paneId)
  lastSent.delete(paneId)
  reportLanded.delete(paneId)
  restoredQuiet.delete(paneId)
}

const STATUS_RANK: Record<PaneStatus, number> = {
  'waiting-approval': 3,
  'waiting-input': 2,
  working: 1,
  idle: 0
}

/** The most attention-worthy status across a tab's panes (drives the tab dot). */
export function tabStatus(tab: TabState): PaneStatus {
  let best: PaneStatus = 'idle'
  for (const id of collectPaneIds(tab)) {
    const s = paneStatus.get(id)?.status
    if (s && STATUS_RANK[s] > STATUS_RANK[best]) best = s
  }
  return best
}

export function newId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`
}

export function activeTab(): TabState | undefined {
  return state.tabs.find((t) => t.id === state.activeTabId)
}

export function tabOfPane(paneId: string): TabState | undefined {
  return state.tabs.find((t) => containsPane(t, paneId))
}

function containsPane(tab: TabState, paneId: string): boolean {
  return collectPaneIds(tab).includes(paneId)
}

export function collectPaneIds(tab: TabState): string[] {
  const ids: string[] = []
  const walk = (node: TabState['layout']): void => {
    if (node.type === 'pane') ids.push(node.id)
    else node.children.forEach(walk)
  }
  walk(tab.layout)
  return ids
}

function serialize(): PersistedState {
  return {
    version: 1,
    activeTabId: state.activeTabId,
    tabs: state.tabs,
    fontSize: state.fontSize,
    gitPanelOpen: state.gitPanelOpen,
    gitAutoFetch: state.gitAutoFetch,
    // Only while open, like crewSettings below: a state file that never had an
    // orchestra in it stays exactly what it was.
    ...(state.orchPanelOpen ? { orchPanelOpen: true } : {}),
    // Only once some crew has a setting, so the state file of somebody who has
    // never opened an orchestra is byte for byte what it was.
    ...(Object.keys(state.crewSettings).length > 0 ? { crewSettings: state.crewSettings } : {})
  }
}

let saveTimer: number | undefined

/** Debounced save — call after every mutation. */
export function persist(): void {
  window.clearTimeout(saveTimer)
  saveTimer = window.setTimeout(() => void flushPersist(), 500)
}

/** Immediate save — used for the quit flush. */
export async function flushPersist(): Promise<void> {
  window.clearTimeout(saveTimer)
  await window.lightclaude.state.save(serialize())
}
