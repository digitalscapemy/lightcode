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
