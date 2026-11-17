import {
  adoptLegacySquads,
  carryNodeMeta,
  crewHue,
  crewMembers,
  handleError,
  linkSegments,
  nextHandle,
  normaliseCrews,
  workerSlot
} from '../../shared/crew'
import type { CrewEventKind } from '../../shared/crew'
import { AGENTS } from '../../shared/agents'
import { rolePrompt, roleById } from '../../shared/roles'
import type { PaneStatus, StatusUpdate, UsageUpdate } from '../../shared/ipc'
import type {
  CrewSettings,
  LayoutNode,
  Orientation,
  PaneNode,
  PaneNodeCrew,
  PersistedState,
  TabState
} from '../../shared/types'
import {
  forgetPane as forgetBabysitter,
  handleStatusChange,
  isBabysitterOn,
  noteManualInput
} from './babysitter'
import { agentOptions } from './agentPicker'
import { alertDialog, choiceDialog, confirmDialog, promptDialog } from './confirmDialog'
import { forgetCoexist, sharedRootWarnings } from './coexist'
import { STATUS_WORD, crewEvents } from './crewEvents'
import { drawCrewOverlay } from './crewOverlay'
import { approveFromKey, crewSignal, refreshStrips, syncStrips } from './crewStrip'
import type { StripCrew, StripHooks, StripWorker } from './crewStrip'
import { quotePrompt } from './fanOut'
import { refreshGitTree } from './gitTree'
import { refreshOrchPanel } from './orchPanel'
import { LAYOUT_RESIZED, renderLayout } from './layout'
import { buildLayout } from './layouts'
import type { LayoutPreset } from './layouts'
import { TerminalPane } from './pane'
import type { CrewAction, PaneCallbacks } from './pane'
import { neighbour, nextAttentionPane, paneRects, step } from './paneNav'
import type { Direction } from './paneNav'
import {
  FONT_SIZE_DEFAULT,
  activeTab,
  clampFontSize,
  expectingAgent,
  forgetCrewSignals,
  newId,
  notifyStatus,
  paneStatus,
  pendingCommand,
  paneUsage,
  persist,
  restoredQuiet,
  state,
  tabOfPane
} from './store'
import { firstPaneId, paneIds, paneNodes, removePane, splitPane } from './splitTree'
import { refreshTabStatuses, renderTabs } from './tabbar'
import { askRemove, removeAll, worktreeOfPane } from './worktrees'
import { noteRecentProject } from './recentProjects'

export const panes = new Map<string, TerminalPane>()
const tabViews = new Map<string, HTMLElement>()
const lastFocusedInTab = new Map<string, string>()
const maximizedPane = new Map<string, string>() // tabId -> paneId

function contentEl(): HTMLElement {
  return document.getElementById('content')!
}

const paneCallbacks: PaneCallbacks = {
  onCloseRequest: (paneId) => void closePaneRequest(paneId),
  onFocus: (paneId) => {
    state.focusedPaneId = paneId
    const tab = tabOfPane(paneId)
    if (tab) lastFocusedInTab.set(tab.id, paneId)
    document.querySelectorAll('.pane.focused').forEach((p) => p.classList.remove('focused'))
    panes.get(paneId)?.el.classList.add('focused')
    refreshCrewLinks()
    // The git tree describes whichever pane has the focus, so moving the focus
    // is a change of subject. Without this it kept describing the pane you left
    // until the one you arrived at happened to draw a prompt — which, in a pane
    // sitting idle at a shell, is never.
    refreshGitTree()
  },
  onSplit: (paneId, orientation, before) => void splitAt(paneId, orientation, before),
  onToggleMaximize: (paneId) => toggleMaximizePane(paneId),
  isMaximized: (paneId) => maximizedPane.get(tabOfPane(paneId)?.id ?? '') === paneId,
  onRename: (paneId, name) => renamePane(paneId, name),
  onManualInput: (paneId) => noteManualInput(paneId),
  // A worktree opens beside the pane it came from: side by side is the point,
  // since that is where comparing two agents' work actually happens.
  onSplitInto: (paneId, cwd) => void splitAt(paneId, 'row', false, cwd),
  crewMenu: (paneId) => crewMenu(paneId),
  onCrewAction: (paneId, action) => void crewAction(paneId, action),
  onCrewAlert: (paneId) => goToAsking(paneId)
}

/**
 * Build the pane a layout node describes. `node` carries what the pane is —
 * its role, its crew, its agent — and is left out only for a pane that is
 * none of those things, which is most of them.
 */
function createPane(paneId: string, cwd: string, node?: PaneNode): TerminalPane {
  const pane = new TerminalPane(paneId, cwd, paneCallbacks, node?.role ?? null, node?.agent ?? null)
  if (node?.crew) pane.setCrew(node.crew, crewHue(node.crew.id))
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
  /**
   * Wait for every shell to exist before returning. Off by default because
   * opening sixteen tabs at once should not serialise on sixteen spawns; on for
   * callers that need to talk to the panes straight afterwards.
   */
  awaitSpawn?: boolean
  /** Build the panes later: when the tab is first shown, or by the launch warm-up. */
  defer?: boolean
}

export async function createTab(opts: CreateTabOptions): Promise<void> {
  const layout: LayoutNode = opts.layout ?? { type: 'pane', id: newId('p') }
  noteRecentProject(opts.projectPath)
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
  // A divider drag moves the panes under an orchestra's link lines.
  view.addEventListener(LAYOUT_RESIZED, () => refreshCrewLinks())
  contentEl().appendChild(view)
  tabViews.set(tab.id, view)

  // Deferred: the tab is real (strip, state, persistence) but its terminals
  // and shells are built when it is first shown, or by the launch warm-up.
  if (opts.defer) {
    deferredTabs.add(tab.id)
    renderTabs()
    updateEmptyState()
    persist()
    return
  }
  buildPanes(tab)
  renderTabs()
  updateEmptyState()
  if (opts.activate !== false) activateTab(tab.id)

  const spawns = paneIds(tab.layout).map((pid) => panes.get(pid)!.spawn())
  if (opts.awaitSpawn) await Promise.all(spawns)
  persist()
}

/**
 * Tabs whose panes are not built yet. Restoring sixty terminals at launch used
 * to build every xterm and start every shell in the same instant: the window
 * sat black and unresponsive while sixty PowerShells loaded their profiles.
 * Now only the visible tab is built straight away; the rest follow one at a
 * time (warmUpDeferredTabs), or the moment one is clicked.
 */
const deferredTabs = new Set<string>()

/** Build a deferred tab's panes and start its shells. Safe to call twice. */
function materializeTab(tabId: string): void {
  if (!deferredTabs.delete(tabId)) return
  const tab = state.tabs.find((t) => t.id === tabId)
  if (!tab) return
  buildPanes(tab)
  spawnStaggered(paneIds(tab.layout))
}

/**
 * Start shells a few dozen milliseconds apart rather than all at once. On
 * Windows each spawn is synchronous work in the main process (a ConPTY and a
 * PowerShell); six back to back held it for a third of a second at a time
 * during launch, so the window could not be dragged and the header felt dead.
 */
function spawnStaggered(ids: string[], gapMs = 45): void {
  ids.forEach((pid, i) => {
    window.setTimeout(() => void panes.get(pid)?.spawn(), i * gapMs)
  })
}

/** Build the remaining deferred tabs one at a time, a beat apart. */
function warmUpDeferredTabs(): void {
  const next = (): void => {
    const id = state.tabs.find((t) => deferredTabs.has(t.id))?.id
    if (!id) return
    materializeTab(id)
    // A beat between tabs keeps the window responsive and spreads the shell
    // start-ups instead of launching them all at once.
    window.setTimeout(next, 350)
  }
  window.setTimeout(next, 600)
}

function buildPanes(tab: TabState): void {
  for (const node of paneNodes(tab.layout)) {
    const pane = createPane(node.id, node.cwd ?? tab.projectPath, node)
    if (node.name) pane.setCustomName(node.name)
  }
  rerender(tab)
  // A restored orchestra needs its strip docked; a tab without one skips this.
  if (paneNodes(tab.layout).some((n) => n.crew)) renderCrews()
}

let defaultCwd = ''

export function setDefaultCwd(cwd: string): void {
  defaultCwd = cwd
}

/** "+" button / Ctrl+Shift+T: open a new terminal tab immediately. */
export async function addTab(): Promise<void> {
  await createTab({ projectPath: defaultCwd, name: 'Terminal' })
}

/**
 * "+" right-click: open several tabs at once instead of clicking N times.
 *
 * Only the last tab activates. activateTab() re-fits every pane in the tab it
 * switches to and re-runs syncWebgl() across all tabs, so activating each one in
 * turn would pay that cost N times for N-1 layouts nobody ever sees — and the
 * final syncWebgl() settles the WebGL contexts for every tab anyway.
 */
export async function addTabs(count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    await createTab({
      projectPath: defaultCwd,
      name: 'Terminal',
      activate: i === count - 1
    })
  }
}

/** Explicit "open project" flow (empty state): pick a folder first. */
export async function addTabViaPicker(): Promise<void> {
  const folder = await window.lightclaude.pickFolder()
  if (folder) await createTab({ projectPath: folder })
}

export function activateTab(tabId: string): void {
  materializeTab(tabId)
  state.activeTabId = tabId
  for (const [id, view] of tabViews) view.style.display = id === tabId ? '' : 'none'
  renderTabs()
  const tab = activeTab()
  document.title = tab ? `Light Code · ${tab.name}` : 'Light Code'
  requestAnimationFrame(() => {
    const current = activeTab()
    if (!current || current.id !== tabId) return
    for (const pid of paneIds(current.layout)) panes.get(pid)?.fit()
    syncWebgl()
    refreshStrips() // a strip in a hidden tab stopped reading its workers' lines
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
  for (const node of paneNodes(tab.layout)) crewEvent(node.id, 'closed')
  for (const pid of paneIds(tab.layout)) {
    panes.get(pid)?.dispose()
    panes.delete(pid)
    paneStatus.delete(pid)
    paneUsage.delete(pid)
    expectingAgent.delete(pid)
    lastNotified.delete(pid)
    forgetBabysitter(pid)
    forgetCoexist(pid)
    forgetCrewSignals(pid)
    notifyStatus(pid) // a wait on it settles now, as gone
  }
  tabViews.get(tabId)?.remove()
  tabViews.delete(tabId)
  deferredTabs.delete(tabId) // closed before it was ever built: nothing to start
  lastFocusedInTab.delete(tabId)
  maximizedPane.delete(tabId)
  state.tabs.splice(idx, 1)
  settleCrews() // a crew can span tabs; whoever it left behind is tidied up

  if (state.activeTabId === tabId) {
    const next = state.tabs[Math.min(idx, state.tabs.length - 1)]
    if (next) {
      activateTab(next.id)
    } else {
      state.activeTabId = null
      renderTabs()
      document.title = 'Light Code'
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
  if (tab.id === state.activeTabId) document.title = `Light Code · ${tab.name}`
  persist()
}

/** Remember each pane's live cwd so a restart respawns it in the same folder. */
export function setPaneCwd(paneId: string, cwd: string): void {
  // The prompt hook fires on every prompt render, not only on a `cd`, so this is
  // also the moment to re-read git: a commit or a checkout changes the branch and
  // the dirty marker without the directory moving at all. Deliberately ahead of
  // the early return below, which exists to avoid persisting an unchanged cwd.
  void panes
    .get(paneId)
    ?.refreshGit(cwd)
    .then(() => {
      refreshCoexistWarnings()
      // The panel rides the same signal: a prompt render is when a commit,
      // checkout or merge has just finished, which is when the tree changed.
      refreshGitTree()
    })

  // A prompt has been drawn, so the shell is ready to be typed into — which is
  // when a queued command can safely go in. See store.pendingCommand.
  const queued = pendingCommand.get(paneId)
  if (queued !== undefined) {
    pendingCommand.delete(paneId)
    window.lightclaude.pty.write(paneId, `${queued}\r`)
  }

  const tab = tabOfPane(paneId)
  if (!tab) return
  const node = paneNodes(tab.layout).find((p) => p.id === paneId)
  if (!node || node.cwd === cwd) return
  node.cwd = cwd
  persist()
}

/**
 * Re-apply the shared-working-tree warning across every pane.
 *
 * Runs after a pane's git refresh — the same shell-prompt signal everything
 * else here rides on — and whenever the babysitter is armed or disarmed, since
 * that changes the answer without any directory changing. Cheap: it reads the
 * git snapshot each pane already holds and asks no questions of main.
 */
export function refreshCoexistWarnings(): void {
  const warnings = sharedRootWarnings(
    [...panes.entries()].map(([paneId, pane]) => ({
      paneId,
      root: pane.gitSnapshot()?.root ?? null,
      auto: isBabysitterOn(paneId)
    }))
  )
  for (const [paneId, pane] of panes) pane.setCoexistWarning(warnings.get(paneId) ?? null)
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
  before: boolean,
  /** Overrides the inherited directory — a worktree opens in its own copy. */
  intoCwd?: string,
  /** Typed at the new shell's first prompt. See store.pendingCommand. */
  command?: string,
  opts: {
    /**
     * Move the cursor into the new pane. On by default — a person who splits
     * means to type there; off for a pane opened on somebody else's behalf,
     * which must not snatch the keyboard from whoever is typing.
     */
    focus?: boolean
    /** What the new pane is, beyond its id: its crew, its agent, its role. */
    node?: Omit<Partial<PaneNode>, 'type' | 'id'>
  } = {}
): Promise<string | null> {
  const tab = tabOfPane(targetPaneId)
  if (!tab) return null
  maximizedPane.delete(tab.id) // splitting always restores the grid
  // A new split opens where the source pane currently is, not the tab root.
  const srcCwd = intoCwd ?? paneNodes(tab.layout).find((p) => p.id === targetPaneId)?.cwd
  const newPaneId = newId('p')
  tab.layout = splitPane(tab.layout, targetPaneId, orientation, newPaneId, before)
  const node = paneNodes(tab.layout).find((p) => p.id === newPaneId)
  if (node && opts.node) Object.assign(node, opts.node)
  // Queued before the spawn, so the first prompt cannot be drawn ahead of it.
  if (command !== undefined) pendingCommand.set(newPaneId, command)

  const pane = createPane(newPaneId, srcCwd ?? tab.projectPath, node)
  if (node?.crew) renderCrews() // a new worker gets its card; rerender draws its line
  rerender(tab)
  for (const pid of paneIds(tab.layout)) panes.get(pid)?.scheduleFit()

  await pane.spawn()
  if (tab.id === state.activeTabId) pane.attachWebgl()
  if (opts.focus !== false) pane.focus()
  persist()
  return newPaneId
}

/** The preset whose shape the active tab currently has, if any. */
export function activeLayoutId(presets: LayoutPreset[]): string | null {
  const tab = activeTab()
  if (!tab) return null
  const shape = (node: LayoutNode): string =>
    node.type === 'pane'
      ? 'p'
      : `${node.orientation[0]}(${node.children.map(shape).join(',')})`
  const current = shape(tab.layout)
  let dummy = 0
  return (
    presets.find((p) => shape(buildLayout(p.spec, () => `d${dummy++}`)) === current)?.id ?? null
  )
}

/**
 * Reshape the active tab to a preset layout.
 *
 * Existing panes keep their slot in reading order, and renderLayout reparents
 * pane elements rather than rebuilding them, so a reshape never restarts a
 * running shell. Slots beyond the preset's count are closed — that kills those
 * shells, so it asks first.
 */
export async function applyLayout(preset: LayoutPreset): Promise<void> {
  const tab = activeTab()
  if (!tab) return
  // Ask first, and ask before anything is measured: confirmDialog awaits, and
  // a pty can exit under it, so no count read beforehand still holds after.
  const overflow = paneIds(tab.layout).length - preset.count
  if (overflow > 0) {
    // The panes past the preset's count are the ones that go; if an orchestra
    // lead is among them its workers are left with nobody directing them, which
    // is worth a sentence before rather than a surprise after.
    const losesLead = paneNodes(tab.layout)
      .slice(preset.count)
      .some((n) => n.crew?.lead)
    const ok = await confirmDialog(
      `This layout has ${preset.count} panes, so ${overflow} open ` +
        `${overflow === 1 ? 'pane' : 'panes'} will be closed and ` +
        `${overflow === 1 ? 'its' : 'their'} shell${overflow === 1 ? '' : 's'} ended.` +
        (losesLead ? ' One of them conducts an orchestra; its workers will be left without a lead.' : ''),
      overflow === 1 ? 'Close pane' : 'Close panes'
    )
    if (!ok) {
      restoreFocus(tab) // the dialog took focus off the terminal to open
      return
    }
    if (activeTab()?.id !== tab.id) return
  }

  const existing = paneIds(tab.layout)
  const dropped = existing.slice(preset.count)
  maximizedPane.delete(tab.id) // a reshape always restores the grid

  // Ids in reading order: reuse the panes we are keeping, mint ids for the rest.
  const queue = existing.slice(0, preset.count)
  const reused = queue.length
  while (queue.length < preset.count) queue.push(newId('p'))
  const fresh = queue.slice(reused)

  // buildLayout only knows ids, so carry everything else each kept pane
  // remembers across — its role included. See carryNodeMeta.
  const prev = new Map(paneNodes(tab.layout).map((n) => [n.id, n]))
  let i = 0
  const layout = buildLayout(preset.spec, () => queue[i++]!)
  for (const node of paneNodes(layout)) carryNodeMeta(prev.get(node.id), node)

  for (const pid of dropped) {
    crewEvent(pid, 'closed') // the old layout still holds its node, and its crew
    panes.get(pid)?.dispose()
    panes.delete(pid)
    paneStatus.delete(pid)
    paneUsage.delete(pid)
    expectingAgent.delete(pid)
    lastNotified.delete(pid)
    forgetBabysitter(pid)
    forgetCoexist(pid)
    forgetCrewSignals(pid)
    notifyStatus(pid)
  }
  // New panes open where the first surviving pane is, matching splitAt().
  const srcCwd = (queue[0] ? prev.get(queue[0])?.cwd : undefined) ?? tab.projectPath
  for (const pid of fresh) createPane(pid, srcCwd)

  tab.layout = layout
  if (dropped.length > 0) settleCrews()
  rerender(tab)
  for (const pid of paneIds(tab.layout)) panes.get(pid)?.scheduleFit()

  await Promise.all(fresh.map((pid) => panes.get(pid)!.spawn()))
  if (tab.id === state.activeTabId) {
    for (const pid of fresh) panes.get(pid)?.attachWebgl()
  }
  restoreFocus(tab)
  persist()
}

/**
 * Hand the cursor back after a reshape.
 *
 * renderLayout() detaches every pane element, which blurs whatever had focus,
 * so a reshape always has to give it back. Two things to get right.
 *
 * It goes to the pane the user was already in, not whichever one happens to
 * land first — a reshape they asked for shouldn't also move them somewhere.
 *
 * And it waits for the window itself to be focused. focus() called while it
 * is not sets activeElement without firing a focus event, and xterm only flips
 * its own focus flag on that event: the pane would go on taking keystrokes
 * while drawing no cursor at all, since cursorInactiveStyle is 'none', and
 * nothing afterwards fires the event that would undo it. That is not
 * hypothetical on the shrink path — dropping panes is the one route that shows
 * a dialog, and a dialog is what leaves the window inactive at this point.
 */
function restoreFocus(tab: TabState): void {
  const ids = paneIds(tab.layout)
  const target =
    state.focusedPaneId && ids.includes(state.focusedPaneId)
      ? state.focusedPaneId
      : firstPaneId(tab.layout)
  const apply = (): void => {
    if (activeTab()?.id === tab.id) panes.get(target)?.focus()
  }
  if (document.hasFocus()) apply()
  else window.addEventListener('focus', apply, { once: true })
}

/** Temporarily expand one pane to fill the whole tab; toggle to restore. */
export function toggleMaximizePane(paneId: string): void {
  const tab = tabOfPane(paneId)
  if (!tab) return
  const view = tabViews.get(tab.id)!
  if (maximizedPane.get(tab.id) === paneId) {
    maximizedPane.delete(tab.id)
    rerender(tab)
    for (const pid of paneIds(tab.layout)) panes.get(pid)?.scheduleFit()
  } else {
    maximizedPane.set(tab.id, paneId)
    view.textContent = ''
    view.appendChild(panes.get(paneId)!.el)
    panes.get(paneId)?.scheduleFit()
  }
  panes.get(paneId)?.focus()
}

/**
 * The × on a pane, and Mod+Shift+W.
 *
 * A pane sitting in a worktree is the only window onto that checkout; closing it
 * and saying nothing leaves the folder and the branch behind for ever, which is
 * how an evening of fan-outs ends with twenty-two directories nobody meant to
 * keep. A pane that is not in one closes silently, exactly as it always has —
 * there is nothing to decide, so nothing is asked.
 */
export async function closePaneRequest(paneId: string): Promise<void> {
  const worktree = await worktreeOfPane(paneId)
  if (!worktree) {
    closePane(paneId)
    return
  }
  const answer = await askRemove([worktree])
  if (answer === 'cancel') return
  closePane(paneId)
  if (answer === 'keep') return
  const notes = await removeAll([worktree])
  if (notes.length > 0) await alertDialog(notes.join('\n\n'))
}

export function closePane(paneId: string): void {
  expectingAgent.delete(paneId)
  const tab = tabOfPane(paneId)
  if (!tab) return
  crewEvent(paneId, 'closed') // while its node still says which crew it was in
  maximizedPane.delete(tab.id)
  panes.get(paneId)?.dispose()
  panes.delete(paneId)
  paneStatus.delete(paneId)
  paneUsage.delete(paneId)
  lastNotified.delete(paneId)
  forgetBabysitter(paneId)
  forgetCoexist(paneId)
  forgetCrewSignals(paneId)
  notifyStatus(paneId)

  const newLayout = removePane(tab.layout, paneId)
  if (!newLayout) {
    closeTab(tab.id)
    return
  }
  tab.layout = newLayout
  settleCrews()
  rerender(tab)
  for (const pid of paneIds(tab.layout)) panes.get(pid)?.scheduleFit()
  if (tab.id === state.activeTabId) {
    panes.get(firstPaneId(tab.layout))?.focus()
  }
  persist()
}

/**
 * Put a tab's panes back on screen in its layout, and the link lines over them.
 * renderLayout empties the view first, which takes the lines with it.
 */
function rerender(tab: TabState): void {
  const view = tabViews.get(tab.id)
  if (!view || deferredTabs.has(tab.id)) return
  renderLayout(view, tab.layout, (id) => panes.get(id)!.el)
  refreshCrewLinks()
}

export function updateEmptyState(): void {
  document.getElementById('empty-state')!.hidden = state.tabs.length > 0
}

function regenPaneIds(node: LayoutNode): LayoutNode {
  // Keep the persisted custom name — pane ids change, titles shouldn't.
  if (node.type === 'pane') return { ...node, id: newId('p') }
  return { ...node, children: node.children.map(regenPaneIds) }
}

// ---------- Crews ----------

/** Every pane node in the window, tab by tab, in reading order. */
function allNodes(): PaneNode[] {
  return state.tabs.flatMap((t) => paneNodes(t.layout))
}

function nodeOf(paneId: string): PaneNode | undefined {
  const tab = tabOfPane(paneId)
  return tab ? paneNodes(tab.layout).find((n) => n.id === paneId) : undefined
}

/**
 * Bring every pane's crew chip and colour into line with its node, after
 * something may have changed who is in which crew.
 */
function renderCrews(): void {
  const nodes = allNodes()
  for (const node of nodes) {
    panes.get(node.id)?.setCrew(node.crew ?? null, node.crew ? crewHue(node.crew.id) : 0)
    // A pane that has left its crew — unlinked, or its lead stopped conducting —
    // is a plain pane again and keeps nothing of it: relinked later, its new
    // card must not open on the old crew's last message or report.
    if (!node.crew) forgetCrewSignals(node.id)
  }
  syncStrips(stripCrews(nodes), stripHooks)
  refreshCrewLinks()
  // The panel's crews, and which squad folders' reports are watched. Both a
  // no-op in a window that has never had a crew.
  refreshOrchPanel()
}

function stripWorker(node: PaneNode): StripWorker {
  return {
    pane: node.id,
    handle: node.crew!.handle,
    role: node.role?.id ?? null,
    agent: node.agent ?? null
  }
}

/** One strip per lead, carrying every worker of its crew — in any tab. */
function stripCrews(nodes: PaneNode[]): StripCrew[] {
  const out: StripCrew[] = []
  for (const node of nodes) {
    if (!node.crew?.lead || !panes.has(node.id)) continue
    const crew = node.crew
    out.push({
      lead: node.id,
      crewId: crew.id,
      hue: crewHue(crew.id),
      collapsed: crew.stripCollapsed === true,
      paused: state.crewSettings[crew.id]?.paused === true,
      workers: crewMembers(nodes, crew.id)
        .filter((n) => !n.crew!.lead && panes.has(n.id))
        .map(stripWorker)
    })
  }
  return out
}

const stripHooks: StripHooks = {
  mount: (leadId, el) => panes.get(leadId)?.mountStrip(el),
  setAlert: (leadId, count, detail) => panes.get(leadId)?.setCrewAlert(count, detail),
  roleBadge: (paneId) => panes.get(paneId)?.roleBadge() ?? null,
  drivenTimes: (paneId) => panes.get(paneId)?.drivenTimes() ?? 0,
  lastLine: (paneId) => panes.get(paneId)?.lastOutputLine() ?? null,
  exited: (paneId) => panes.get(paneId)?.exited ?? true,
  focus: (paneId) => revealPane(paneId),
  addWorker: (leadId) => void addWorker(leadId),
  setCollapsed: (leadId, collapsed) => {
    const crew = nodeOf(leadId)?.crew
    if (!crew?.lead) return
    if (collapsed) crew.stripCollapsed = true
    else delete crew.stripCollapsed
    renderCrews()
    persist()
  },
  setPaused: (crewId, paused) => setCrewPaused(crewId, paused),
  afterSignal: () => refreshCrewLinks()
}

/**
 * Repair the crews after panes went away, and redraw them.
 *
 * A lead closed under its workers leaves them a crew without a conductor,
 * which is allowed; a crew reduced to one worker is just a pane, and is
 * unlinked. See normaliseCrews. Cheap, and a no-op in a window with no crews.
 */
function settleCrews(): void {
  normaliseCrews(allNodes())
  renderCrews()
}

/**
 * Outline the focused pane's crew-mates, so it is plain which panes belong
 * with the one you are in. Nothing is outlined while a pane in no crew has the
 * focus, so a window that never uses crews never sees it.
 */
function refreshCrewLinks(): void {
  const nodes = allNodes()
  const focused = nodes.find((n) => n.id === state.focusedPaneId)
  const crewId = focused?.crew?.id
  const linked =
    crewId === undefined ? new Set<string>() : new Set(crewMembers(nodes, crewId).map((n) => n.id))
  if (linked.size < 2) linked.clear()
  for (const [id, pane] of panes) pane.el.classList.toggle('crew-linked', linked.has(id))

  // The lines, in each tab the crew has panes in. None while a pane is
  // maximized — the panes they would join are not on screen — and none in a
  // tab where no crew is in focus, which clears whatever was drawn there.
  const members =
    crewId === undefined || linked.size === 0
      ? []
      : crewMembers(nodes, crewId).map((n) => ({ pane: n.id, lead: n.crew!.lead === true }))
  const working = new Set(
    members.filter((m) => paneStatus.get(m.pane)?.status === 'working').map((m) => m.pane)
  )
  const hue = crewId === undefined ? 0 : crewHue(crewId)
  for (const tab of state.tabs) {
    const view = tabViews.get(tab.id)
    if (!view) continue
    const segments =
      members.length === 0 || maximizedPane.has(tab.id)
        ? []
        : linkSegments(paneRects(tab.layout), members)
    drawCrewOverlay(view, segments, hue, working)
  }
}

/**
 * The approval badge on a lead was clicked: go to the first of its workers
 * stuck on a permission prompt, in reading order.
 */
function goToAsking(leadId: string): void {
  const crew = nodeOf(leadId)?.crew
  if (!crew) return
  const asking = crewMembers(allNodes(), crew.id).find(
    (n) => n.id !== leadId && paneStatus.get(n.id)?.status === 'waiting-approval'
  )
  if (asking) revealPane(asking.id)
}

/**
 * Mod+Shift+Y: approve the permission prompt the focused pane's crew is
 * waiting on — the focused pane's own first, then its crew-mates in reading
 * order. Outside a crew there is nothing to do. See crewStrip.approveFromKey.
 */
export function approveFocusedCrew(): void {
  const focused = state.focusedPaneId ? nodeOf(state.focusedPaneId) : undefined
  const crew = focused?.crew
  if (!focused || !crew) return
  const mates = crewMembers(allNodes(), crew.id).filter((n) => n.id !== focused.id)
  void approveFromKey([focused, ...mates].filter((n) => panes.has(n.id)).map(stripWorker))
}

/** The pane menu's crew rows. Only what applies to this pane is offered. */
function crewMenu(paneId: string): { label: string; action: CrewAction }[] {
  const crew = nodeOf(paneId)?.crew
  if (crew?.lead) {
    return [
      { label: 'Add Worker…', action: 'add-worker' },
      { label: 'Agent ▸', action: 'agent' },
      { label: 'Stop Conducting', action: 'unlink' }
    ]
  }
  if (crew) {
    return [
      { label: 'Agent ▸', action: 'agent' },
      { label: 'Unlink from Orchestra', action: 'unlink' }
    ]
  }
  return [
    { label: 'Conduct from Here', action: 'conduct' },
    // Offered only when there is an orchestra to join: a row that can only
    // lead to "there is nothing to link to" is noise in a menu this short.
    ...(allNodes().some((n) => n.crew?.lead)
      ? [{ label: 'Link to Orchestra…', action: 'link' as const }]
      : [])
  ]
}

async function crewAction(paneId: string, action: CrewAction): Promise<void> {
  const node = nodeOf(paneId)
  if (!node) return
  if (action === 'add-worker') return addWorker(paneId)
  if (action === 'agent') return switchAgent(paneId)
  if (action === 'link') return linkToOrchestra(paneId)
  if (action === 'conduct') {
    conduct(paneId)
    return
  }
  const crew = node.crew
  if (!crew) return
  if (crew.lead) {
    // The lead going takes the whole crew with it: a lead is what makes the
    // others an orchestra rather than panes that happen to share a colour.
    // Only the links go — every shell keeps running exactly as it was.
    for (const member of crewMembers(allNodes(), crew.id)) delete member.crew
    delete state.crewSettings[crew.id]
  } else {
    delete node.crew
  }
  settleCrews()
  persist()
}

/** Ask a lead's new worker for a handle, then open it beside its crew. */
async function addWorker(leadId: string): Promise<void> {
  const crew = nodeOf(leadId)?.crew
  if (!crew?.lead) return
  const taken = (): string[] => crewMembers(allNodes(), crew.id).map((n) => n.crew!.handle)
  const handle = await promptDialog({
    message: 'New worker, the lead addresses it as @<handle>',
    initial: nextHandle('worker', taken()),
    confirmLabel: 'Add worker',
    validate: (v) => handleError(v, taken())
  })
  // The dialog awaited: the lead may have been closed or stopped leading since.
  const tab = tabOfPane(leadId)
  const lead = nodeOf(leadId)
  if (handle === null || !tab || !lead?.crew?.lead || lead.crew.id !== crew.id) {
    panes.get(leadId)?.focus()
    return
  }
  const agent = await pickAgent(`What should @${handle} run?`)
  if (agent === null || !nodeOf(leadId)?.crew?.lead) {
    panes.get(leadId)?.focus()
    return
  }
  // In the lead's folder rather than the split target's: the largest worker may
  // well be sitting in a worktree of its own, and that is not the new one's.
  const isWindows = window.lightclaude.platform === 'win32'
  const command = AGENTS[agent]!.launch(null, { plan: false, quote: (p) => quotePrompt(p, isWindows) })
  await openWorker({
    near: leadId,
    crewId: crew.id,
    handle: nextHandle(handle, taken()),
    cwd: lead.cwd ?? tab.projectPath,
    // A shell types nothing, exactly as a worker opened before agents could
    // be picked did.
    ...(command !== '' ? { command } : {}),
    node: { agent }
  })
}

/**
 * Ask which agent to run, with Claude Code as the primary button. Agents whose
 * command was not found are dimmed and say why, but stay pickable (see
 * agentPicker). Null when dismissed.
 */
async function pickAgent(message: string): Promise<string | null> {
  const available = await window.lightclaude.agent.available()
  // The last button is the primary one, and Claude is the one most people mean.
  const options = agentOptions(available).reverse()
  const i = await choiceDialog(
    message,
    options.map((o) => o.label),
    options.map((o) => o.note)
  )
  return i === null ? null : (options[i]?.id ?? null)
}

/**
 * "Agent ▸": start another agent in a crew member's pane, and remember it as
 * the pane's agent — for the chip, the card, the keys that interrupt it, and
 * main's ≈ status. Typed at the shell like any command, so when something
 * already seems to be running there, the person is asked first rather than
 * refused: they can see the pane, and the app is only guessing.
 */
async function switchAgent(paneId: string): Promise<void> {
  const agent = await pickAgent('Which agent should this pane run?')
  const node = nodeOf(paneId)
  const pane = panes.get(paneId)
  if (agent === null || !node?.crew || !pane || pane.exited) return
  const adapter = AGENTS[agent]!
  const status = paneStatus.get(paneId)?.status
  const busy =
    (status !== undefined && status !== 'idle') || (await window.lightclaude.pty.claudeActive(paneId))
  // Typing the command into a running agent would send it as a message.
  if (busy && adapter.launch(null, { plan: false, quote: (p) => p }) !== '') {
    const go = await confirmDialog(
      'Something seems to be running in this pane already, so the command would be typed into it. ' +
        `Exit it first, or type the ${adapter.label} command anyway?`,
      'Type it anyway'
    )
    if (!go || !panes.has(paneId)) return
  }
  // The role rides in front of the first message for an agent with no wrapper.
  let role: string | null = null
  if (node.role && adapter.rolePromptVia === 'first-message') {
    const found = roleById((await window.lightclaude.roles.list(node.cwd ?? pane.cwd)).roles, node.role.id)
    role = found ? rolePrompt(found) : null
  }
  const current = nodeOf(paneId)
  if (!current?.crew || !panes.has(paneId)) return
  current.agent = agent
  pane.setAgent(agent)
  window.lightclaude.pty.setAgent(paneId, agent)
  const isWindows = window.lightclaude.platform === 'win32'
  const command = adapter.launch(null, {
    plan: false,
    quote: (p) => quotePrompt(p, isWindows),
    rolePrompt: role
  })
  if (command !== '') {
    window.lightclaude.pty.write(paneId, `${command}\r`)
    // The role is a first message, so a turn is coming; an empty agent waits.
    if (role !== null) expectingAgent.add(paneId)
  }
  renderCrews()
  persist()
  pane.focus()
}

/**
 * Make a pane in no crew the lead of a new one — "Conduct from Here", and
 * `lc spawn` from a pane that was conducting nothing. Returns the crew, or
 * null when the pane is gone or already in one.
 */
export function conduct(paneId: string, crewId = newId('c')): PaneNodeCrew | null {
  const node = nodeOf(paneId)
  if (!node || node.crew) return null
  node.crew = { id: crewId, handle: nextHandle(node.role?.id ?? 'lead', [], true), lead: true }
  settleCrews()
  persist()
  return node.crew
}

/**
 * Open a worker for a crew in `near`'s tab, beside the crew's other panes
 * there (see crew.workerSlot), and return its pane id.
 *
 * `near` is the pane asking: the lead for "Add Worker…", the caller for
 * `lc spawn`. `focus: false` leaves the keyboard where it is, which is what
 * a pane opened on an agent's behalf must do.
 */
export async function openWorker(o: {
  near: string
  crewId: string
  handle: string
  cwd: string
  command?: string
  node?: Omit<Partial<PaneNode>, 'type' | 'id' | 'crew'>
  orientation?: Orientation
  focus?: boolean
}): Promise<string | null> {
  const tab = tabOfPane(o.near)
  if (!tab) return null
  const here = new Set(paneIds(tab.layout))
  const members = crewMembers(allNodes(), o.crewId).filter((n) => here.has(n.id))
  const workers = members.filter((n) => !n.crew!.lead).map((n) => n.id)
  const lead = members.find((n) => n.crew!.lead)?.id ?? o.near
  const slot = workerSlot(paneRects(tab.layout), lead, workers)
  return splitAt(slot.target, o.orientation ?? slot.orientation, false, o.cwd, o.command, {
    ...(o.focus === false ? { focus: false } : {}),
    node: { ...o.node, crew: { id: o.crewId, handle: o.handle } }
  })
}

/**
 * Record something that happened to a crew member, for `lc events` and the
 * panel's timeline. A pane in no crew records nothing.
 */
export function crewEvent(
  paneId: string,
  kind: CrewEventKind,
  extra: { state?: string; by?: string; detail?: string } = {}
): void {
  const crew = nodeOf(paneId)?.crew
  if (!crew) return
  crewEvents.push({ crew: crew.id, pane: paneId, handle: crew.handle, kind, ...extra })
}

/**
 * Pause a crew, or resume it: the person at the screen taking the baton back
 * from the lead. While paused, `lc` refuses every command that would act on
 * the crew (lcPolicy.pauseGate); the buttons on the cards keep working.
 */
export function setCrewPaused(crewId: string, paused: boolean): void {
  writeCrewSetting(crewId, 'paused', paused)
  const lead = crewMembers(allNodes(), crewId).find((n) => n.crew!.lead)
  if (lead) crewEvent(lead.id, paused ? 'paused' : 'resumed', { by: 'you' })
  renderCrews()
  persist()
}

/**
 * Turn one of a crew's permissions on or off, from the Orchestra panel:
 * whether its lead may answer permission prompts (`lc approve`), and whether
 * crossing the crew's edge is refused rather than warned about. Both start
 * off; see lcPolicy.approveGate and crew.canDrive.
 */
export function setCrewSetting(crewId: string, key: 'leadMayApprove' | 'strict', on: boolean): void {
  writeCrewSetting(crewId, key, on)
  renderCrews()
  persist()
}

/**
 * Settings are stored only while true, and a crew with none left has no entry
 * at all — so the state file of a crew nobody has changed says nothing about it.
 */
function writeCrewSetting(crewId: string, key: keyof CrewSettings, on: boolean): void {
  const settings = { ...state.crewSettings[crewId] }
  if (on) settings[key] = true
  else delete settings[key]
  if (Object.keys(settings).length > 0) state.crewSettings[crewId] = settings
  else delete state.crewSettings[crewId]
}

/** Put a pane in no crew into an existing orchestra, under a handle. */
async function linkToOrchestra(paneId: string): Promise<void> {
  const leads = allNodes().filter((n) => n.crew?.lead && n.id !== paneId)
  if (leads.length === 0) return
  let lead = leads[0]!
  if (leads.length > 1) {
    const labels = leads.map((n) => {
      const where = tabOfPane(n.id)?.name
      return `${panes.get(n.id)?.label() ?? n.id}${where ? ` · ${where}` : ''}`
    })
    const pick = await choiceDialog('Link this pane to which orchestra?', labels)
    if (pick === null) {
      panes.get(paneId)?.focus()
      return
    }
    lead = leads[pick]!
  }
  const crewId = lead.crew!.id
  const taken = (): string[] => crewMembers(allNodes(), crewId).map((n) => n.crew!.handle)
  const handle = await promptDialog({
    message: 'Its lead will address this pane as @<handle>',
    initial: nextHandle(nodeOf(paneId)?.role?.id ?? 'worker', taken()),
    confirmLabel: 'Link',
    validate: (v) => handleError(v, taken())
  })
  // Both ends re-read after the dialog: either pane may have gone meanwhile.
  const now = nodeOf(paneId)
  const stillLed = crewMembers(allNodes(), crewId).some((n) => n.crew!.lead)
  if (handle !== null && now && !now.crew && stillLed) {
    now.crew = { id: crewId, handle: nextHandle(handle, taken()) }
    settleCrews()
    persist()
  }
  panes.get(paneId)?.focus()
}

// ---------- Token usage badges ----------

/**
 * Each pane shows its OWN session — main attributes sessions per pane.
 *
 * The badge shows context fill, and only that. It used to lead with the sum of
 * every token ever billed, but ~99% of that is cache reads — the same cached
 * prefix re-counted every turn — so it climbed into the hundreds of millions
 * and measured nothing. Context is the thing that actually runs out.
 */
export function applyUsage(u: UsageUpdate): void {
  const pane = panes.get(u.paneId)
  if (!pane) return
  paneUsage.set(u.paneId, u)
  const win = contextWindowFor(u.model)
  const text =
    u.contextTokens > 0
      ? `${fmtTokens(u.contextTokens)}/${fmtTokens(win)} · ${Math.round((u.contextTokens / win) * 100)}%`
      : null
  const tooltip =
    `Session ${u.sessionId}\n` +
    (u.contextTokens > 0
      ? `context ${u.contextTokens.toLocaleString()} / ${win.toLocaleString()}\n`
      : '') +
    `in ${u.totals.input.toLocaleString()} · out ${u.totals.output.toLocaleString()}\n` +
    `cache read ${u.totals.cacheRead.toLocaleString()} · cache write ${u.totals.cacheCreate.toLocaleString()}` +
    (u.model ? `\n${u.model}` : '')
  pane.setUsage(text, tooltip)
}

/** The session behind this pane is gone — drop every trace of it. */
export function clearPaneSignals(paneId: string): void {
  crewEvent(paneId, 'exited')
  paneStatus.delete(paneId)
  paneUsage.delete(paneId)
  const pane = panes.get(paneId)
  pane?.setStatus(null)
  pane?.setUsage(null)
  refreshTabStatuses()
  crewSignal(paneId)
}

// ---------- Claude activity status ----------

const lastNotified = new Map<string, number>()
const NOTIFY_COOLDOWN_MS = 5000

/** Bring a pane into view and focus it (used by clicks / notifications). */
export function focusPane(paneId: string): void {
  const tab = tabOfPane(paneId)
  if (!tab) return
  lastFocusedInTab.set(tab.id, paneId)
  if (state.activeTabId !== tab.id) activateTab(tab.id)
  else panes.get(paneId)?.focus()
}

/** Where keyboard navigation starts from, falling back to the first pane. */
function navOrigin(tab: TabState): { ids: string[]; from: string } | null {
  const ids = paneIds(tab.layout)
  const focused = state.focusedPaneId
  const from = focused && ids.includes(focused) ? focused : ids[0]
  return from ? { ids, from } : null
}

/**
 * Focus a pane, carrying a maximized view along with it.
 *
 * If the tab is zoomed into one pane, focusing another without moving the zoom
 * would put the cursor in something that is not on screen. The user zoomed
 * deliberately, so move the zoom rather than drop it.
 */
function goToPane(tab: TabState, paneId: string): void {
  if (maximizedPane.get(tab.id)) {
    maximizedPane.set(tab.id, paneId)
    const view = tabViews.get(tab.id)!
    view.textContent = ''
    view.appendChild(panes.get(paneId)!.el)
    panes.get(paneId)?.scheduleFit()
  }
  panes.get(paneId)?.focus()
}

/** Ctrl+Tab / Ctrl+Shift+Tab: cycle through the active tab's panes. */
export function focusPaneStep(delta: 1 | -1): void {
  const tab = activeTab()
  if (!tab) return
  const origin = navOrigin(tab)
  if (!origin) return
  const target = step(origin.ids, origin.from, delta)
  if (target) goToPane(tab, target)
}

/**
 * Mod+Shift+J: go to the pane that needs you.
 *
 * The tab dot already says *which tab* wants attention; nothing took you to the
 * pane. In a 4×4 grid across several tabs that meant opening Mission Control
 * and clicking, which is a lot of hunting for something the app already knows.
 *
 * Panes blocked on a permission prompt come first: nothing happens in them at
 * all until a human answers, where a pane that merely finished its turn is only
 * waiting for the next instruction. Within each group the order is reading
 * order, tab by tab, and each press moves on, so a whole grid can be cleared
 * with one key held down.
 */
export function focusAttentionPane(): void {
  const all = state.tabs.flatMap((tab) =>
    paneIds(tab.layout).map((id) => ({ id, status: paneStatus.get(id)?.status }))
  )
  // Inside an orchestra, its own members come first: conducting means working
  // through your crew's questions, not being pulled to another project's tab
  // halfway through. Once the crew has nothing waiting, the rest follow.
  const crewId = state.focusedPaneId ? nodeOf(state.focusedPaneId)?.crew?.id : undefined
  const mine =
    crewId === undefined
      ? new Set<string>()
      : new Set(crewMembers(allNodes(), crewId).map((n) => n.id))
  const inCrew = mine.size > 0 ? all.filter((p) => mine.has(p.id)) : []
  // A crew whose only waiting pane is the focused one has nothing else to
  // offer — a lead resting at its prompt after delegating is the usual case —
  // so that counts as nothing waiting in the crew, and the search widens.
  const crewTarget = nextAttentionPane(inCrew, state.focusedPaneId)
  const target =
    crewTarget !== null && crewTarget !== state.focusedPaneId
      ? crewTarget
      : nextAttentionPane(all, state.focusedPaneId)
  if (target === null) return // nothing is waiting: do nothing, quietly
  revealPane(target)
}

/**
 * Bring a pane into view from somewhere that may be a maximized tab — a worker
 * card, the approval badge, Mod+Shift+J. Same tab goes through goToPane, which
 * carries a maximized view along with the focus; focusPane handles the tab
 * switch when it is somewhere else.
 */
export function revealPane(paneId: string): void {
  const tab = tabOfPane(paneId)
  if (!tab) return
  if (tab.id === state.activeTabId) {
    lastFocusedInTab.set(tab.id, paneId)
    goToPane(tab, paneId)
  } else focusPane(paneId)
}

/** Mod+Alt+Arrow: move focus to the pane lying that way on screen. */
export function focusPaneDirection(dir: Direction): void {
  const tab = activeTab()
  if (!tab) return
  const origin = navOrigin(tab)
  if (!origin) return
  const target = neighbour(paneRects(tab.layout), origin.from, dir)
  if (target) goToPane(tab, target)
}

/**
 * Show in the pane that the agent CLI drove it. `offScope` is canDrive's
 * warning when the driver was outside the pane's crew. See TerminalPane.markDriven.
 */
export function markDrivenByLc(paneId: string, offScope?: string): void {
  panes.get(paneId)?.markDriven(offScope)
  crewSignal(paneId) // the card's "lc N"
}

/**
 * Human label for a pane in notifications — its tab name, and for a pane in an
 * orchestra its handle too: "auth · @developer" says which of five panes in
 * one tab is asking, where the tab name alone says only which project.
 */
function paneLabel(paneId: string): string {
  const tab = tabOfPane(paneId)?.name ?? 'Claude'
  const crew = nodeOf(paneId)?.crew
  if (!crew) return tab
  return crew.lead ? `${tab} · ♪ orchestra` : `${tab} · @${crew.handle}`
}

/**
 * Whether the person can already see that this pane is waiting: its own tab is
 * on screen, or — for a worker — its lead's is, where the strip shows the card
 * and the lead's header carries the approval badge.
 */
function inView(paneId: string): boolean {
  if (!document.hasFocus()) return false
  if (tabOfPane(paneId)?.id === state.activeTabId) return true
  const crew = nodeOf(paneId)?.crew
  if (!crew || crew.lead) return false
  const lead = crewMembers(allNodes(), crew.id).find((n) => n.crew!.lead)
  return lead !== undefined && tabOfPane(lead.id)?.id === state.activeTabId
}

/** Central status sink: updates the pane pill, tab dot, notifications, babysitter. */
export function applyStatus(u: StatusUpdate): void {
  if (!panes.has(u.paneId)) return
  // An agent a fan-out asked for has now reported, so the pane is no longer
  // merely expected to have one. Left set, it would make `lc wait --for idle`
  // hang for ever on a pane whose agent has since finished and exited, because
  // that pane reports `idle` and the expectation says to keep waiting.
  if (u.status !== 'idle') expectingAgent.delete(u.paneId)
  // Something is running in it again, so a restored card stops saying otherwise.
  restoredQuiet.delete(u.paneId)
  const prev = paneStatus.get(u.paneId)?.status
  paneStatus.set(u.paneId, u)
  if (prev !== u.status) {
    crewEvent(u.paneId, 'status', {
      state: STATUS_WORD[u.status],
      ...(u.status === 'waiting-approval' && u.lastTool ? { detail: u.lastTool } : {})
    })
  }
  const estimated = u.source === 'heuristic'
  panes.get(u.paneId)?.setStatus(u.status, u.lastTool, estimated)
  refreshTabStatuses()
  maybeNotify(prev, u)
  // The babysitter types into a pane on its own. It does that only on Claude's
  // word that a turn ended, never on a guess from the terminal going quiet.
  handleStatusChange(u.paneId, u.status, estimated)
  notifyStatus(u.paneId)
  crewSignal(u.paneId)
}

/** OS notification when Claude transitions from working to a waiting state. */
function maybeNotify(prev: PaneStatus | undefined, u: StatusUpdate): void {
  if (u.status !== 'waiting-input' && u.status !== 'waiting-approval') return
  if (prev !== 'working') return // only fire on the working → waiting edge
  // Don't nag when the user is already looking right at this pane.
  if (inView(u.paneId)) return
  const now = Date.now()
  if (now - (lastNotified.get(u.paneId) ?? 0) < NOTIFY_COOLDOWN_MS) return
  lastNotified.set(u.paneId, now)

  const name = paneLabel(u.paneId)
  const title =
    u.status === 'waiting-approval' ? `${name}: needs approval` : `${name}: waiting for you`
  // An estimated status (≈) comes from an agent that is not Claude, and only
  // ever says a turn seems to have ended.
  const body =
    u.status === 'waiting-approval'
      ? u.lastTool
        ? `Claude wants to run ${u.lastTool}`
        : 'Claude is waiting for a permission'
      : u.source === 'heuristic'
        ? `${AGENTS[nodeOf(u.paneId)?.agent ?? '']?.label ?? 'The agent'} seems to have finished its turn`
        : 'Claude finished its turn'
  try {
    const n = new Notification(title, { body, silent: false })
    n.onclick = (): void => {
      window.focus()
      focusPane(u.paneId)
    }
  } catch {
    // Notifications unavailable / not permitted — status pill still shows it.
  }
}

export function fmtTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1e6) return `${Math.round(n / 1000)}k`
  return `${(n / 1e6).toFixed(1)}M`
}

/**
 * Context window by model, per Anthropic's model catalog (2026-06): all
 * current-generation models are 1M — Fable/Mythos 5, Opus 4.6+, Sonnet 4.6+
 * and Sonnet 5 — while Haiku and older generations are 200K.
 */
export function contextWindowFor(model: string | null): number {
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
/**
 * Resize the terminal text in every pane. `delta` of 0 resets to the default.
 *
 * Applies to all panes, including ones in background tabs: a hidden pane's
 * fit() is a no-op while it has no size, and activateTab() refits it on the way
 * back in, so it picks the new size up without a special case here.
 */
export function adjustFontSize(delta: number): void {
  const next = delta === 0 ? FONT_SIZE_DEFAULT : clampFontSize(state.fontSize + delta)
  if (next === state.fontSize) return
  state.fontSize = next
  for (const pane of panes.values()) pane.setFontSize(next)
  persist()
}

export async function restore(persisted: PersistedState): Promise<void> {
  // Before any pane is built — TerminalPane reads state.fontSize at construction.
  if (persisted.fontSize) state.fontSize = clampFontSize(persisted.fontSize)
  state.gitPanelOpen = persisted.gitPanelOpen ?? false
  state.gitAutoFetch = persisted.gitAutoFetch ?? true
  state.orchPanelOpen = persisted.orchPanelOpen ?? false
  state.crewSettings = persisted.crewSettings ?? {}
  const layouts = persisted.tabs.map((tab) => regenPaneIds(tab.layout))
  // Before any pane is built, so each is built knowing its crew. Squads from
  // before crews existed become crews here; anything a crew's last session
  // left bent is straightened. Neither touches a pane that is in no squad.
  const nodes = layouts.flatMap(paneNodes)
  adoptLegacySquads(nodes)
  normaliseCrews(nodes)
  // Fresh shells, and no agent started in any of them: the cards say so until
  // something reports. Only crew members — a plain pane has no card.
  for (const node of nodes) if (node.crew) restoredQuiet.add(node.id)
  const shown =
    persisted.activeTabId && persisted.tabs.some((t) => t.id === persisted.activeTabId)
      ? persisted.activeTabId
      : persisted.tabs[0]?.id
  for (const [i, tab] of persisted.tabs.entries()) {
    await createTab({
      id: tab.id,
      projectPath: tab.projectPath,
      name: tab.name,
      layout: layouts[i]!,
      activate: false,
      // Built when shown (the one on screen, just below) or by the warm-up.
      defer: true
    })
  }
  if (shown) activateTab(shown)
  warmUpDeferredTabs()
}
