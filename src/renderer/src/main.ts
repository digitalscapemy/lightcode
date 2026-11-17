import '@xterm/xterm/css/xterm.css'
import './styles.css'
import * as app from './app'
import { initAboutUi } from './about'
import { isBabysitterOn, onBabysitterChange, toggleBabysitter } from './babysitter'
import { noteCrewOutput } from './crewStrip'
import { closeTabWithWorktrees, openFanOut } from './fanOutUi'
import { initShortcuts } from './keys'
import { initLc } from './lcHandlers'
import { initGitTree, toggleGitTree } from './gitTree'
import { initLayoutPicker } from './layoutPicker'
import { openMission, toggleMissionControl } from './missionControl'
import { initOrchPanel, toggleOrchPanel } from './orchPanel'
import { clearDropTarget, hasDropTarget } from './pane'
import { initShortcutsUi } from './shortcuts'
import { openSquad } from './squadUi'
import { initUpdateToast } from './toast'
import { initTooltips } from './ui/tooltip'
import { registerCommands, type Command } from './commands'
import { openPalette, openShortcutHelp, togglePalette } from './palette'
import { initToolbar } from './toolbar'
import { initWelcome } from './welcome'
import { flushPersist, notifyStatus, persist, state } from './store'
import { initTabBar } from './tabbar'
import { openSetup } from './setup'

async function boot(): Promise<void> {
  document.body.classList.add(`platform-${window.lightclaude.platform}`)

  initTabBar({
    onActivate: (id) => app.activateTab(id),
    onClose: (id) => void closeTabWithWorktrees(id),
    onRename: (id, name) => app.renameTab(id, name),
    // DOM order is already live-synced during the drag; re-rendering here
    // would cut the snap animation short.
    onReorderCommit: () => persist(),
    onAdd: () => void app.addTab(),
    onAddMany: (count) => void app.addTabs(count)
  })

  // Arming or disarming a pane changes whether two agents are about to tread on
  // each other, without any directory having changed — so the warning is
  // recomputed here as well as on every shell prompt.
  onBabysitterChange(app.refreshCoexistWarnings)

  initShortcutsUi()
  initAboutUi()
  initLayoutPicker()
  initUpdateToast()
  initTooltips()
  initLc()

  document
    .getElementById('win-min')!
    .addEventListener('click', () => window.lightclaude.window.minimize())
  document
    .getElementById('win-max')!
    .addEventListener('click', () => window.lightclaude.window.maximizeToggle())
  document
    .getElementById('win-close')!
    .addEventListener('click', () => window.lightclaude.window.close())

  // A file dropped anywhere that isn't a terminal pane must do nothing at all.
  // Chromium's default is to navigate the window to the dropped file, which
  // would replace the running app — and every pty with it. The panes handle
  // (and preventDefault) their own drops; this covers every miss.
  window.addEventListener('dragover', (e) => {
    e.preventDefault()
    // The pane taking the drop has already marked itself by the time this
    // bubbles up. Anywhere else, say "no" with the cursor rather than promising
    // a drop that silently goes nowhere.
    if (e.dataTransfer && !hasDropTarget()) e.dataTransfer.dropEffect = 'none'
  })
  window.addEventListener('drop', (e) => {
    e.preventDefault()
    clearDropTarget()
  })
  // A drag can also end without ever reaching a drop: Esc mid-drag, or a
  // release over another app. Neither fires dragleave on the pane it was over,
  // so the outline would otherwise stay lit until the next drag.
  window.addEventListener('dragend', () => clearDropTarget())
  window.addEventListener('blur', () => clearDropTarget())

  window.lightclaude.pty.onData((paneId, data) => {
    app.panes.get(paneId)?.write(data)
    // One map lookup for a pane in no orchestra; see crewStrip.noteCrewOutput.
    noteCrewOutput(paneId)
  })
  window.lightclaude.pty.onExit((paneId, code) => {
    app.panes.get(paneId)?.showExitOverlay(code)
    app.clearPaneSignals(paneId) // the dot/badge would otherwise outlive the session
    notifyStatus(paneId) // a wait on it settles now: reached for exit, early otherwise
  })
  window.lightclaude.pty.onCwd((paneId, cwd) => app.setPaneCwd(paneId, cwd))
  window.lightclaude.usage.onUpdate((u) => app.applyUsage(u))
  window.lightclaude.usage.onStatus((u) => app.applyStatus(u))

  window.lightclaude.state.onFlushRequest(() => {
    void flushPersist().finally(() => window.lightclaude.state.flushDone())
  })

  initShortcuts({
    'split-right': () => void app.splitFocused('row'),
    'split-down': () => void app.splitFocused('column'),
    'new-tab': () => void app.addTab(),
    'close-pane': () => {
      // Same question the × asks: one action, one behaviour.
      if (state.focusedPaneId) void app.closePaneRequest(state.focusedPaneId)
    },
    'mission-control': () => toggleMissionControl(),
    'git-tree': () => toggleGitTree(),
    'font-larger': () => app.adjustFontSize(1),
    'font-smaller': () => app.adjustFontSize(-1),
    'font-reset': () => app.adjustFontSize(0),
    'pane-next': () => app.focusPaneStep(1),
    'pane-prev': () => app.focusPaneStep(-1),
    'pane-attention': () => app.focusAttentionPane(),
    'pane-left': () => app.focusPaneDirection('left'),
    'pane-right': () => app.focusPaneDirection('right'),
    'pane-up': () => app.focusPaneDirection('up'),
    'pane-down': () => app.focusPaneDirection('down'),
    'crew-approve': () => app.approveFocusedCrew(),
    'orch-panel': () => toggleOrchPanel(),
    'command-palette': () => togglePalette(),
    'shortcut-help': () => openShortcutHelp(),
    'fan-out': () => void openFanOut(),
    'layout-picker': () => document.getElementById('layout-btn')?.click(),
    'pane-maximize': () => {
      if (state.focusedPaneId) app.toggleMaximizePane(state.focusedPaneId)
    }
  })

  registerCommands(buildCommands())
  initToolbar()
  initWelcome()

  document.getElementById('fanout-btn')!.addEventListener('click', () => void openFanOut())
  document.getElementById('squad-btn')!.addEventListener('click', () => void openSquad())
  document.getElementById('git-btn')!.addEventListener('click', toggleGitTree)
  document.getElementById('orch-btn')!.addEventListener('click', toggleOrchPanel)

  document
    .getElementById('mission-btn')!
    .addEventListener('click', () => openMission())

  const home = await window.lightclaude.homedir()
  app.setDefaultCwd(home)

  // Returning users get their tabs back exactly as they left them. With none
  // to restore — a first launch, or the last tab closed — the welcome page
  // shows instead of a bare shell; Enter there opens that same terminal.
  const persisted = await window.lightclaude.state.load()
  if (persisted && persisted.tabs.length > 0) {
    await app.restore(persisted)
  }
  app.updateEmptyState()

  // After restore, not before: whether the panel is docked open is part of the
  // persisted state, and initialising it earlier would read the default every
  // time and quietly discard the user's choice.
  initGitTree()
  initOrchPanel()
}

/**
 * Every action, by name, for the command palette and the shortcut cheat-sheet.
 * Each one calls exactly what its button or key already calls: the palette is
 * another way in, never another implementation.
 */
function buildCommands(): Command[] {
  const click = (id: string) => (): void => document.getElementById(id)?.click()
  const focused = (): string | null => state.focusedPaneId
  const hasPane = (): boolean => focused() !== null
  const onFocused = (fn: (paneId: string) => void) => (): void => {
    const p = focused()
    if (p) fn(p)
  }
  return [
    // General
    { id: 'palette', title: 'Command palette', group: 'General', icon: 'search', shortcut: 'command-palette', run: () => void openPalette() },
    { id: 'shortcuts', title: 'Keyboard shortcuts', group: 'General', icon: 'keyboard', keywords: 'help keys cheat sheet', shortcut: 'shortcut-help', run: openShortcutHelp },
    { id: 'setup', title: 'Setup & tools: install Claude, Codex, Antigravity CLI', group: 'General', icon: 'sparkle', keywords: 'install agent cli check codex agy antigravity claude help guide', run: openSetup },
    { id: 'projects', title: 'Project shortcuts', group: 'General', icon: 'projects', keywords: 'folders paths profile', run: click('projects-btn') },
    { id: 'accounts', title: 'Claude accounts', group: 'General', icon: 'accounts', keywords: 'config dir login', run: click('accounts-btn') },
    { id: 'open-project', title: 'Open project folder', group: 'General', icon: 'folder', keywords: 'new tab pick folder', run: () => void app.addTabViaPicker() },
    { id: 'about', title: 'About Light Code and what is new', group: 'General', icon: 'info', keywords: 'version changelog release notes', run: click('version-btn') },
    { id: 'updates', title: 'Check for updates', group: 'General', icon: 'sparkle', keywords: 'upgrade version', run: () => void window.lightclaude.updates.check() },
    // Tabs & panes
    { id: 'new-tab', title: 'New terminal tab', group: 'Tabs & panes', icon: 'plus', shortcut: 'new-tab', run: () => void app.addTab() },
    { id: 'new-tabs-3', title: 'Open 3 tabs', group: 'Tabs & panes', icon: 'plus', keywords: 'several many bulk', run: () => void app.addTabs(3) },
    { id: 'new-tabs-5', title: 'Open 5 tabs', group: 'Tabs & panes', icon: 'plus', keywords: 'several many bulk', run: () => void app.addTabs(5) },
    {
      id: 'rename-tab',
      title: 'Rename tab',
      group: 'Tabs & panes',
      icon: 'rename',
      when: () => !!state.activeTabId,
      run: () => document.querySelector('#tabs .tab.active')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    },
    { id: 'split-right', title: 'Split right', group: 'Tabs & panes', icon: 'splitRight', shortcut: 'split-right', when: hasPane, run: () => void app.splitFocused('row') },
    { id: 'split-down', title: 'Split down', group: 'Tabs & panes', icon: 'splitDown', shortcut: 'split-down', when: hasPane, run: () => void app.splitFocused('column') },
    { id: 'maximize', title: 'Maximize or restore pane', group: 'Tabs & panes', icon: 'maximize', keywords: 'zoom fullscreen', shortcut: 'pane-maximize', when: hasPane, run: onFocused((p) => app.toggleMaximizePane(p)) },
    { id: 'close-pane', title: 'Close pane', group: 'Tabs & panes', icon: 'close', shortcut: 'close-pane', when: hasPane, run: onFocused((p) => void app.closePaneRequest(p)) },
    { id: 'auto-continue', title: 'Toggle auto-continue for this pane', group: 'Tabs & panes', icon: 'repeat', keywords: 'babysitter continue keep going', when: hasPane, run: onFocused((p) => void toggleBabysitter(p, !isBabysitterOn(p))) },
    // Navigate
    { id: 'pane-next', title: 'Next pane', group: 'Navigate', shortcut: 'pane-next', run: () => app.focusPaneStep(1) },
    { id: 'pane-prev', title: 'Previous pane', group: 'Navigate', shortcut: 'pane-prev', run: () => app.focusPaneStep(-1) },
    { id: 'pane-left', title: 'Focus pane on the left', group: 'Navigate', shortcut: 'pane-left', run: () => app.focusPaneDirection('left') },
    { id: 'pane-right', title: 'Focus pane on the right', group: 'Navigate', shortcut: 'pane-right', run: () => app.focusPaneDirection('right') },
    { id: 'pane-up', title: 'Focus pane above', group: 'Navigate', shortcut: 'pane-up', run: () => app.focusPaneDirection('up') },
    { id: 'pane-down', title: 'Focus pane below', group: 'Navigate', shortcut: 'pane-down', run: () => app.focusPaneDirection('down') },
    { id: 'attention', title: 'Jump to the pane that needs you', group: 'Navigate', keywords: 'waiting approval attention', shortcut: 'pane-attention', run: () => app.focusAttentionPane() },
    // Agents
    { id: 'fan-out', title: 'Fan-out: one task, several agents', group: 'Agents', icon: 'fanOut', keywords: 'worktrees parallel branches', shortcut: 'fan-out', run: () => void openFanOut() },
    { id: 'squad', title: 'New orchestra from preset roles (Squad)', group: 'Agents', icon: 'squad', keywords: 'squad roles developer reviewer security devops', run: () => void openSquad() },
    { id: 'orchestra', title: 'Orchestra panel', group: 'Agents', icon: 'orchestra', keywords: 'lead workers crew conduct', shortcut: 'orch-panel', run: () => toggleOrchPanel() },
    { id: 'approve', title: 'Approve the waiting worker', group: 'Agents', icon: 'check', keywords: 'yes permission prompt', shortcut: 'crew-approve', run: () => app.approveFocusedCrew() },
    // Panels
    { id: 'worktrees', title: 'Worktrees panel', group: 'Panels', icon: 'worktrees', keywords: 'git tree branches', shortcut: 'git-tree', run: () => toggleGitTree() },
    { id: 'mission', title: 'Mission Control', group: 'Panels', icon: 'mission', keywords: 'all sessions broadcast overview', shortcut: 'mission-control', run: () => toggleMissionControl() },
    // Layout
    { id: 'layout', title: 'Choose pane layout', group: 'Layout', icon: 'layout', keywords: 'grid split arrange', shortcut: 'layout-picker', run: click('layout-btn') },
    // View
    { id: 'font-larger', title: 'Larger text', group: 'View', keywords: 'zoom in font size', shortcut: 'font-larger', run: () => app.adjustFontSize(1) },
    { id: 'font-smaller', title: 'Smaller text', group: 'View', keywords: 'zoom out font size', shortcut: 'font-smaller', run: () => app.adjustFontSize(-1) },
    { id: 'font-reset', title: 'Reset text size', group: 'View', keywords: 'zoom font size default', shortcut: 'font-reset', run: () => app.adjustFontSize(0) }
  ]
}

void boot()
