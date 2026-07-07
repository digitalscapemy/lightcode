import type { UsageUpdate } from '../../shared/ipc'
import type { LayoutNode, Orientation, PersistedState, TabState } from '../../shared/types'
import { renderLayout } from './layout'
import { TerminalPane } from './pane'
import type { PaneCallbacks } from './pane'
import { activeTab, newId, persist, state, tabOfPane } from './store'
import { firstPaneId, paneIds, paneNodes, removePane, splitPane } from './splitTree'
import { renderTabs } from './tabbar'

export const panes = new Map<string, TerminalPane>()
const tabViews = new Map<string, HTMLElement>()
const lastFocusedInTab = new Map<string, string>()
const maximizedPane = new Map<string, string>() // tabId -> paneId

function contentEl(): HTMLElement {
  return document.getElementById('content')!
}

const paneCallbacks: PaneCallbacks = {
  onCloseRequest: (paneId) => closePane(paneId),
  onFocus: (paneId) => {
    state.focusedPaneId = paneId
    const tab = tabOfPane(paneId)
    if (tab) lastFocusedInTab.set(tab.id, paneId)
    document.querySelectorAll('.pane.focused').forEach((p) => p.classList.remove('focused'))
    panes.get(paneId)?.el.classList.add('focused')
  },
  onSplit: (paneId, orientation, before) => void splitAt(paneId, orientation, before),
  onToggleMaximize: (paneId) => toggleMaximizePane(paneId),
  isMaximized: (paneId) => maximizedPane.get(tabOfPane(paneId)?.id ?? '') === paneId,
  onRename: (paneId, name) => renamePane(paneId, name)
}

function createPane(paneId: string, cwd: string): TerminalPane {
  const pane = new TerminalPane(paneId, cwd, paneCallbacks)
  panes.set(paneId, pane)
  return pane
}

export function basename(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? p
}

export interface CreateTabOptions {
  projectPath: string
  id?: string
  name?: string
  layout?: LayoutNode
  activate?: boolean
}

export async function createTab(opts: CreateTabOptions): Promise<void> {
  const layout: LayoutNode = opts.layout ?? { type: 'pane', id: newId('p') }
  const tab: TabState = {
    id: opts.id ?? newId('t'),
    name: opts.name ?? basename(opts.projectPath),
    projectPath: opts.projectPath,
    layout
  }
  state.tabs.push(tab)

  const view = document.createElement('div')
  view.className = 'tab-view'
  view.style.display = 'none'
  contentEl().appendChild(view)
  tabViews.set(tab.id, view)

  for (const node of paneNodes(tab.layout)) {
    const pane = createPane(node.id, node.cwd ?? tab.projectPath)
    if (node.name) pane.setCustomName(node.name)
  }
  renderLayout(view, tab.layout, (id) => panes.get(id)!.el)

  renderTabs()
  updateEmptyState()
  if (opts.activate !== false) activateTab(tab.id)

  for (const pid of paneIds(tab.layout)) void panes.get(pid)!.spawn()
  persist()
}

let defaultCwd = ''

export function setDefaultCwd(cwd: string): void {
  defaultCwd = cwd
}

/** "+" button / Ctrl+Shift+T: open a new terminal tab immediately. */
export async function addTab(): Promise<void> {
  await createTab({ projectPath: defaultCwd, name: 'Terminal' })
}

/** Explicit "open project" flow (empty state): pick a folder first. */
export async function addTabViaPicker(): Promise<void> {
  const folder = await window.lightclaude.pickFolder()
  if (folder) await createTab({ projectPath: folder })
}

export function activateTab(tabId: string): void {
  state.activeTabId = tabId
  for (const [id, view] of tabViews) view.style.display = id === tabId ? '' : 'none'
  renderTabs()
  const tab = activeTab()
  document.title = tab ? `LightClaude — ${tab.name}` : 'LightClaude'
  requestAnimationFrame(() => {
    const current = activeTab()
    if (!current || current.id !== tabId) return
    for (const pid of paneIds(current.layout)) panes.get(pid)?.fit()
    syncWebgl()
    // Don't steal focus from an in-progress tab rename — the dblclick that
    // opened the input fires right after the activating click.
    if (document.activeElement?.classList.contains('tab-rename')) return
    const remembered = lastFocusedInTab.get(current.id)
    const target = remembered ? panes.get(remembered) : undefined
    ;(target ?? panes.get(firstPaneId(current.layout)))?.focus()
  })
  persist()
}

/** WebGL contexts are scarce — only the visible tab's terminals get one. */
function syncWebgl(): void {
  for (const tab of state.tabs) {
    const isActive = tab.id === state.activeTabId
    for (const pid of paneIds(tab.layout)) {
      const pane = panes.get(pid)
      if (!pane) continue
      if (isActive) pane.attachWebgl()
      else pane.detachWebgl()
    }
  }
}

export function closeTab(tabId: string): void {
  const idx = state.tabs.findIndex((t) => t.id === tabId)
  if (idx === -1) return
  const tab = state.tabs[idx]
  for (const pid of paneIds(tab.layout)) {
    panes.get(pid)?.dispose()
    panes.delete(pid)
  }
  tabViews.get(tabId)?.remove()
  tabViews.delete(tabId)
  lastFocusedInTab.delete(tabId)
  maximizedPane.delete(tabId)
  state.tabs.splice(idx, 1)

  if (state.activeTabId === tabId) {
    const next = state.tabs[Math.min(idx, state.tabs.length - 1)]
    if (next) {
      activateTab(next.id)
    } else {
      state.activeTabId = null
      renderTabs()
      document.title = 'LightClaude'
    }
  } else {
    renderTabs()
  }
  updateEmptyState()
  persist()
}

export function renameTab(tabId: string, name: string): void {
  const tab = state.tabs.find((t) => t.id === tabId)
  if (!tab) return
  tab.name = name
  renderTabs()
  if (tab.id === state.activeTabId) document.title = `LightClaude — ${tab.name}`
  persist()
}

/** Remember each pane's live cwd so a restart respawns it in the same folder. */
export function setPaneCwd(paneId: string, cwd: string): void {
  const tab = tabOfPane(paneId)
  if (!tab) return
  const node = paneNodes(tab.layout).find((p) => p.id === paneId)
  if (!node || node.cwd === cwd) return
  node.cwd = cwd
  persist()
}

/** Persist a pane's custom title on its layout node so it survives restarts. */
export function renamePane(paneId: string, name: string | null): void {
  const tab = tabOfPane(paneId)
  if (!tab) return
  const node = paneNodes(tab.layout).find((p) => p.id === paneId)
  if (!node) return
  if (name) node.name = name
  else delete node.name
  panes.get(paneId)?.setCustomName(name)
  panes.get(paneId)?.focus()
  persist()
}

export async function splitFocused(orientation: Orientation): Promise<void> {
  const tab = activeTab()
  if (!tab) return
  const ids = paneIds(tab.layout)
  const target =
    state.focusedPaneId && ids.includes(state.focusedPaneId) ? state.focusedPaneId : ids[0]
  await splitAt(target, orientation, false)
}

export async function splitAt(
  targetPaneId: string,
  orientation: Orientation,
  before: boolean
): Promise<void> {
  const tab = tabOfPane(targetPaneId)
  if (!tab) return
  maximizedPane.delete(tab.id) // splitting always restores the grid
  // A new split opens where the source pane currently is, not the tab root.
  const srcCwd = paneNodes(tab.layout).find((p) => p.id === targetPaneId)?.cwd
  const newPaneId = newId('p')
  tab.layout = splitPane(tab.layout, targetPaneId, orientation, newPaneId, before)

  const pane = createPane(newPaneId, srcCwd ?? tab.projectPath)
  const view = tabViews.get(tab.id)!
  renderLayout(view, tab.layout, (id) => panes.get(id)!.el)
  for (const pid of paneIds(tab.layout)) panes.get(pid)?.scheduleFit()

  await pane.spawn()
  if (tab.id === state.activeTabId) pane.attachWebgl()
  pane.focus()
  persist()
}

/** Temporarily expand one pane to fill the whole tab; toggle to restore. */
export function toggleMaximizePane(paneId: string): void {
  const tab = tabOfPane(paneId)
  if (!tab) return
  const view = tabViews.get(tab.id)!
  if (maximizedPane.get(tab.id) === paneId) {
    maximizedPane.delete(tab.id)
    renderLayout(view, tab.layout, (id) => panes.get(id)!.el)
    for (const pid of paneIds(tab.layout)) panes.get(pid)?.scheduleFit()
  } else {
    maximizedPane.set(tab.id, paneId)
    view.textContent = ''
    view.appendChild(panes.get(paneId)!.el)
    panes.get(paneId)?.scheduleFit()
  }
  panes.get(paneId)?.focus()
}

export function closePane(paneId: string): void {
  const tab = tabOfPane(paneId)
  if (!tab) return
  maximizedPane.delete(tab.id)
  panes.get(paneId)?.dispose()
  panes.delete(paneId)

  const newLayout = removePane(tab.layout, paneId)
  if (!newLayout) {
    closeTab(tab.id)
    return
  }
  tab.layout = newLayout
  const view = tabViews.get(tab.id)!
  renderLayout(view, tab.layout, (id) => panes.get(id)!.el)
  for (const pid of paneIds(tab.layout)) panes.get(pid)?.scheduleFit()
  if (tab.id === state.activeTabId) {
    panes.get(firstPaneId(tab.layout))?.focus()
  }
  persist()
}

export function updateEmptyState(): void {
  document.getElementById('empty-state')!.hidden = state.tabs.length > 0
}

function regenPaneIds(node: LayoutNode): LayoutNode {
  // Keep the persisted custom name — pane ids change, titles shouldn't.
  if (node.type === 'pane') return { ...node, id: newId('p') }
  return { ...node, children: node.children.map(regenPaneIds) }
}

// ---------- Token usage badges ----------

/** Each pane shows its OWN session — main attributes sessions per pane. */
export function applyUsage(u: UsageUpdate): void {
  const pane = panes.get(u.paneId)
  if (!pane) return
  const total = u.totals.input + u.totals.output + u.totals.cacheRead + u.totals.cacheCreate
  const win = contextWindowFor(u.model)
  const text =
    u.contextTokens > 0
      ? `${fmtTokens(total)} · ${fmtTokens(u.contextTokens)}/${fmtTokens(win)}`
      : fmtTokens(total)
  const tooltip =
    `Session ${u.sessionId}\n` +
    `in ${u.totals.input.toLocaleString()} · out ${u.totals.output.toLocaleString()} · ` +
    `cache read ${u.totals.cacheRead.toLocaleString()} · cache write ${u.totals.cacheCreate.toLocaleString()}` +
    (u.contextTokens > 0
      ? `\ncontext ${u.contextTokens.toLocaleString()} / ${win.toLocaleString()}`
      : '') +
    (u.model ? `\n${u.model}` : '')
  pane.setUsage(text, tooltip)
}

function fmtTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1e6) return `${Math.round(n / 1000)}k`
  return `${(n / 1e6).toFixed(1)}M`
}

/**
 * Context window by model, per Anthropic's model catalog (2026-06): all
 * current-generation models are 1M — Fable/Mythos 5, Opus 4.6+, Sonnet 4.6+
 * and Sonnet 5 — while Haiku and older generations are 200K.
 */
function contextWindowFor(model: string | null): number {
  if (!model) return 200_000
  const m = model.toLowerCase()
  if (m.includes('[1m]') || m.includes('fable') || m.includes('mythos')) return 1_000_000
  if (m.includes('haiku')) return 200_000
  const ver = /-(\d+)(?:-(\d+))?/.exec(m) // "claude-opus-4-8" -> 4, 8
  if (!ver) return 200_000
  const major = Number(ver[1])
  const minor = Number(ver[2] ?? 0)
  if (m.includes('opus')) return major > 4 || (major === 4 && minor >= 6) ? 1_000_000 : 200_000
  if (m.includes('sonnet')) return major >= 5 || (major === 4 && minor >= 6) ? 1_000_000 : 200_000
  return 200_000
}

/** Rebuild tabs/layout from disk, spawning fresh shell sessions. */
export async function restore(persisted: PersistedState): Promise<void> {
  for (const tab of persisted.tabs) {
    await createTab({
      id: tab.id,
      projectPath: tab.projectPath,
      name: tab.name,
      layout: regenPaneIds(tab.layout),
      activate: false
    })
  }
  const target =
    persisted.activeTabId && state.tabs.some((t) => t.id === persisted.activeTabId)
      ? persisted.activeTabId
      : state.tabs[0]?.id
  if (target) activateTab(target)
}
