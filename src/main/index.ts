import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeTheme } from 'electron'
import { existsSync } from 'fs'
import { mkdir, readdir, unlink, writeFile } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import { IPC } from '../shared/ipc'
import type { ClipboardPasteResult } from '../shared/ipc'
import type { PersistedState, ShortcutsConfig } from '../shared/types'
import { PtyManager } from './ptyManager'
import {
  importCandidates,
  loadShortcuts,
  parseProfiles,
  saveShortcuts
} from './shortcuts'
import { loadState, saveState } from './stateStore'
import { initUpdater, scheduleUpdateCheck } from './updater'
import { UsageWatcher } from './usageWatcher'

// Keep the pre-rename app name so userData stays %APPDATA%\lightclaude —
// renaming it would silently abandon existing state.json and shortcuts.json.
app.setName('lightclaude')

const usageWatcher = new UsageWatcher()
const ptyManager = new PtyManager(usageWatcher)
let mainWindow: BrowserWindow | null = null
let isQuitting = false

function registerIpc(): void {
  ptyManager.register()
  initUpdater(() => mainWindow)

  ipcMain.handle(IPC.StateLoad, (): PersistedState | null => loadState())

  ipcMain.handle(IPC.StateSave, (_e, state: PersistedState): void => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      const b = mainWindow.getNormalBounds()
      state.window = {
        width: b.width,
        height: b.height,
        x: b.x,
        y: b.y,
        maximized: mainWindow.isMaximized()
      }
    }
    saveState(state)
  })

  ipcMain.handle(IPC.PickFolder, async (): Promise<string | null> => {
    if (!mainWindow) return null
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Select a project folder',
      properties: ['openDirectory']
    })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })

  ipcMain.handle(IPC.Homedir, (): string => homedir())

  ipcMain.handle(IPC.ShortcutsLoad, () => loadShortcuts())
  ipcMain.handle(IPC.ShortcutsSave, (_e, cfg: ShortcutsConfig) => {
    const result = saveShortcuts(cfg)
    if (result.ok) {
      usageWatcher.setConfigRoots(cfg.accounts.map((a) => a.configDir))
    }
    return result
  })
  ipcMain.handle(IPC.ShortcutsImport, () => parseProfiles(importCandidates()))

  // Terminal paste: clipboard images (Snipping Tool / Win+Shift+S) have no
  // file path, so save them to a temp .png and let the renderer paste the path.
  ipcMain.handle(IPC.ClipboardPaste, async (): Promise<ClipboardPasteResult> => {
    const img = clipboard.readImage()
    if (!img.isEmpty()) {
      const dir = pasteDir()
      await mkdir(dir, { recursive: true })
      const file = join(dir, `paste-${Date.now()}.png`)
      await writeFile(file, img.toPNG())
      return { type: 'image', path: file }
    }
    const text = clipboard.readText()
    return text ? { type: 'text', text } : null
  })

  ipcMain.on(IPC.WinMinimize, () => mainWindow?.minimize())
  ipcMain.on(IPC.WinMaximize, () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    else if (mainWindow.isMaximized()) mainWindow.unmaximize()
    else mainWindow.maximize()
  })
  ipcMain.on(IPC.WinClose, () => mainWindow?.close())
}

function pasteDir(): string {
  return join(app.getPath('temp'), 'lightclaude-paste')
}

/** Pasted screenshots accumulate in temp — drop anything older than a day. */
async function cleanPasteDir(): Promise<void> {
  try {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000
    for (const name of await readdir(pasteDir())) {
      const m = /^paste-(\d+)\.png$/.exec(name)
      if (m && Number(m[1]) < cutoff) await unlink(join(pasteDir(), name)).catch(() => {})
    }
  } catch {
    // dir doesn't exist yet
  }
}

function createWindow(): void {
  const persisted = loadState()
  nativeTheme.themeSource = 'dark' // app is dark-only

  // In packaged builds Windows takes the icon from the exe (electron-builder);
  // this path covers dev runs.
  const devIcon = join(__dirname, '../../build/icon.png')

  const win = persisted?.window
  mainWindow = new BrowserWindow({
    ...(existsSync(devIcon) ? { icon: devIcon } : {}),
    width: win?.width ?? 1280,
    height: win?.height ?? 800,
    x: win?.x,
    y: win?.y,
    minWidth: 600,
    minHeight: 400,
    show: false,
    autoHideMenuBar: true,
    // macOS keeps native traffic lights inset into the custom tabbar;
    // Windows/Linux are fully frameless with our own controls.
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 12, y: 12 } }
      : { frame: false }),
    backgroundColor: '#050505',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  })

  ptyManager.setTarget(mainWindow.webContents)
  usageWatcher.setTarget(mainWindow.webContents)

  // A renderer reload (Ctrl+R / HMR full-reload) respawns every pane with new
  // ids — kill the old ptys so they don't linger as orphans. Fresh spawns
  // rebind their usage watches, so drop the stale ones too.
  mainWindow.webContents.on('did-navigate', () => {
    ptyManager.killAll()
    usageWatcher.unwatchAll()
  })

  if (win?.maximized) mainWindow.maximize()
  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
    scheduleUpdateCheck()
  })

  // On close, ask the renderer to flush its (debounced) state before quitting.
  mainWindow.on('close', (e) => {
    if (isQuitting) return
    e.preventDefault()
    let finished = false
    const finish = (): void => {
      if (finished) return
      finished = true
      isQuitting = true
      mainWindow?.close()
    }
    ipcMain.once(IPC.FlushDone, finish)
    mainWindow?.webContents.send(IPC.FlushState)
    setTimeout(finish, 1000) // a hung renderer must not block exit
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  // Seed usage roots before any pane spawns so restored panes bind everywhere.
  usageWatcher.setConfigRoots(loadShortcuts().accounts.map((a) => a.configDir))
  registerIpc()
  createWindow()
  void cleanPasteDir()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  app.quit()
})

app.on('will-quit', () => {
  ptyManager.killAll()
  usageWatcher.unwatchAll()
})
