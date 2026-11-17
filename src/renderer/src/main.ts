import '@xterm/xterm/css/xterm.css'
import './styles.css'
import * as app from './app'
import { initAboutUi } from './about'
import { onBabysitterChange } from './babysitter'
import { noteCrewOutput } from './crewStrip'
import { closeTabWithWorktrees, openFanOut } from './fanOutUi'
import { MOD_LABEL, initShortcuts } from './keys'
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
import { flushPersist, notifyStatus, persist, state } from './store'
import { initTabBar } from './tabbar'

async function boot(): Promise<void> {
  document.body.classList.add(`platform-${window.lightclaude.platform}`)
  // The HTML spells shortcuts the Windows way; rewrite them for macOS. Anything
  // built in JS should use MOD_LABEL directly instead of relying on this.
  if (window.lightclaude.platform === 'darwin') {
    for (const key of document.querySelectorAll('.empty-card .hint .key')) {
      key.textContent = (key.textContent ?? '').replace('Ctrl', '⌘')
    }
  }
  document.getElementById('mission-btn')!.title = `Mission Control (${MOD_LABEL}+Shift+M)`
  document.getElementById('git-btn')!.title = `Git tree (${MOD_LABEL}+Shift+G)`
  document.getElementById('orch-btn')!.title = `Orchestra (${MOD_LABEL}+Shift+O)`

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

  document
    .getElementById('empty-open')!
    .addEventListener('click', () => void app.addTabViaPicker())

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
    'orch-panel': () => toggleOrchPanel()
  })

  document.getElementById('fanout-btn')!.addEventListener('click', () => void openFanOut())
  document.getElementById('squad-btn')!.addEventListener('click', () => void openSquad())
  document.getElementById('git-btn')!.addEventListener('click', toggleGitTree)
  document.getElementById('orch-btn')!.addEventListener('click', toggleOrchPanel)

  document
    .getElementById('mission-btn')!
    .addEventListener('click', () => openMission())

  const home = await window.lightclaude.homedir()
  app.setDefaultCwd(home)

  const persisted = await window.lightclaude.state.load()
  if (persisted && persisted.tabs.length > 0) {
    await app.restore(persisted)
  } else {
    await app.createTab({ projectPath: home, name: 'Home' })
  }
  app.updateEmptyState()

  // After restore, not before: whether the panel is docked open is part of the
  // persisted state, and initialising it earlier would read the default every
  // time and quietly discard the user's choice.
  initGitTree()
  initOrchPanel()
}

void boot()
