import type { PaneStatus, StatusUpdate, UsageUpdate } from '../../shared/ipc'
import type { PersistedState, TabState } from '../../shared/types'

export interface AppState {
  tabs: TabState[]
  activeTabId: string | null
  focusedPaneId: string | null
}

export const state: AppState = {
  tabs: [],
  activeTabId: null,
  focusedPaneId: null
}

/** Latest Claude activity state per pane (ephemeral — never persisted). */
export const paneStatus = new Map<string, StatusUpdate>()

/** Latest token usage per pane (ephemeral — mirrors what the badge shows). */
export const paneUsage = new Map<string, UsageUpdate>()

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
    tabs: state.tabs
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
