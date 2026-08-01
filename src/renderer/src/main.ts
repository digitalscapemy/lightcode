import '@xterm/xterm/css/xterm.css'
import './styles.css'
import * as app from './app'
import { initAboutUi } from './about'
import { MOD_LABEL, initShortcuts } from './keys'
import { initLayoutPicker } from './layoutPicker'
import { openMission, toggleMissionControl } from './missionControl'
import { initShortcutsUi } from './shortcuts'
import { initUpdateToast } from './toast'
import { flushPersist, persist, state } from './store'
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

  initTabBar({
    onActivate: (id) => app.activateTab(id),
    onClose: (id) => app.closeTab(id),
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

  initShortcutsUi()
  initAboutUi()
  initLayoutPicker()
  initUpdateToast()

  document
    .getElementById('win-min')!
    .addEventListener('click', () => window.lightclaude.window.minimize())
  document
    .getElementById('win-max')!
    .addEventListener('click', () => window.lightclaude.window.maximizeToggle())
  document
    .getElementById('win-close')!
    .addEventListener('click', () => window.lightclaude.window.close())

  window.lightclaude.pty.onData((paneId, data) => app.panes.get(paneId)?.write(data))
  window.lightclaude.pty.onExit((paneId, code) => {
    app.panes.get(paneId)?.showExitOverlay(code)
    app.clearPaneSignals(paneId) // the dot/badge would otherwise outlive the session
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
      if (state.focusedPaneId) app.closePane(state.focusedPaneId)
    },
    'mission-control': () => toggleMissionControl(),
    'font-larger': () => app.adjustFontSize(1),
    'font-smaller': () => app.adjustFontSize(-1),
    'font-reset': () => app.adjustFontSize(0),
    'pane-next': () => app.focusPaneStep(1),
    'pane-prev': () => app.focusPaneStep(-1),
    'pane-left': () => app.focusPaneDirection('left'),
    'pane-right': () => app.focusPaneDirection('right'),
    'pane-up': () => app.focusPaneDirection('up'),
    'pane-down': () => app.focusPaneDirection('down')
  })

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
}

void boot()
