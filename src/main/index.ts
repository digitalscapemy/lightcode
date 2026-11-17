import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeTheme } from 'electron'
import { existsSync } from 'fs'
import { mkdir, readdir, unlink, writeFile } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import { IPC } from '../shared/ipc'
import type { ClipboardPasteResult } from '../shared/ipc'
import type { PersistedState, ShortcutsConfig } from '../shared/types'
import { HookWatcher, installHookAssets, sweepDeadHookDirs } from './agentHooks'
import { agentAvailability } from './agentBins'
import { lastAssistantText } from './agentResult'
import {
  addWorktree,
  checkoutWorktree,
  deleteBranch,
  fetchRemotes,
  gitInfo,
  gitTree,
  prepareSquad,
  pruneWorktrees,
  removeWorktree
} from './git'
import { installLcClient } from './lcClient'
import { LcServer, loadLcEnabled, saveLcEnabled, socketPath } from './lcServer'
import { PtyManager } from './ptyManager'
import { loadRoles } from './roles'
import { setHookSettings, setLcInstalled } from './shell'
import { SquadReports } from './squadReports'
import {
  importCandidates,
  loadShortcuts,
  parseProfiles,
  saveShortcuts
} from './shortcuts'
import {
  claimStateOwnership,
  loadState,
  ownsState,
  releaseStateOwnership,
  saveState
} from './stateStore'
import { initUpdater, scheduleUpdateCheck } from './updater'
import { UsageWatcher } from './usageWatcher'

// Keep the pre-rename app name so userData stays %APPDATA%\lightclaude —
// renaming it would silently abandon existing state.json and shortcuts.json.
app.setName('lightclaude')

const usageWatcher = new UsageWatcher()
const ptyManager = new PtyManager(usageWatcher)
const hookWatcher = new HookWatcher()
const lcServer = new LcServer()
const squadReports = new SquadReports()
let mainWindow: BrowserWindow | null = null
let isQuitting = false

function registerIpc(): void {
  ptyManager.register()
  initUpdater(() => mainWindow)

  ipcMain.handle(IPC.StateLoad, (): PersistedState | null => loadState())

  ipcMain.handle(IPC.StateOwned, (): boolean => ownsState())

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

  // Worktrees: several agents on one repository without treading on each other's
  // files. Reading is cheap enough to run whenever a shell prompt renders.
  ipcMain.handle(IPC.GitInfo, (_e, cwd: string) => gitInfo(cwd))
  ipcMain.handle(IPC.GitWorktreeAdd, (_e, cwd: string, name: string) => addWorktree(cwd, name))
  ipcMain.handle(
    IPC.GitWorktreeRemove,
    (_e, cwd: string, path: string, force: boolean) => removeWorktree(cwd, path, force)
  )
  ipcMain.handle(IPC.GitWorktreePrune, (_e, cwd: string) => pruneWorktrees(cwd))
  ipcMain.handle(IPC.GitBranchDelete, (_e, cwd: string, branch: string) =>
    deleteBranch(cwd, branch)
  )
  // The git tree panel: read-only, and refreshed on the same shell-prompt
  // signal the pane header uses rather than on a timer of its own.
  ipcMain.handle(IPC.GitTree, (_e, cwd: string) => gitTree(cwd))
  ipcMain.handle(IPC.GitWorktreeCheckout, (_e, cwd: string, branch: string) =>
    checkoutWorktree(cwd, branch)
  )
  // The only network call the app makes itself. Fetching changes no branch and
  // no file; pull and push are typed into a pane instead.
  ipcMain.handle(IPC.GitFetch, (_e, cwd: string) => fetchRemotes(cwd))
  // A folder handed out here is one the report watcher may look into, whatever
  // it is called. See squadReports.squadDirAllowed.
  ipcMain.handle(IPC.GitSquadPrepare, async (_e, cwd: string, task: string) => {
    const dir = await prepareSquad(cwd, task)
    if (dir !== null) squadReports.grant(dir)
    return dir
  })

  // A squad's reports: watched while an orchestra on screen has a squad
  // folder, so a report landing lights its worker's card. Read-only, and only
  // ever inside a squad folder's reports/.
  ipcMain.handle(IPC.SquadWatch, (_e, dir: unknown) => squadReports.watch(dir))
  ipcMain.on(IPC.SquadUnwatch, (_e, dir: unknown) => squadReports.unwatch(dir))
  ipcMain.handle(IPC.SquadReadReport, (_e, dir: unknown, name: unknown) =>
    squadReports.read(dir, name)
  )

  ipcMain.handle(IPC.RolesList, (_e, cwd: string) => loadRoles(cwd))

  // `lc result`: a pane's last answer, from the transcript its session writes.
  // Read here because the renderer has no file access and the binding of pane
  // to transcript is the usage watcher's.
  ipcMain.handle(IPC.AgentResult, async (_e, paneId: string): Promise<string | null> => {
    const file = typeof paneId === 'string' ? usageWatcher.transcriptFor(paneId) : null
    return file === null ? null : lastAssistantText(file)
  })

  // Which agents' commands are on PATH, so a picker can say which it cannot find.
  ipcMain.handle(IPC.AgentAvailable, (): Record<string, boolean> => agentAvailability())

  // The agent CLI. Off until switched on, and the switch is remembered.
  const lcState = (): { enabled: boolean; command: string } => ({
    enabled: lcServer.isEnabled(),
    command: 'lc'
  })
  ipcMain.handle(IPC.LcState, () => lcState())
  ipcMain.handle(IPC.LcSetEnabled, async (_e, on: boolean) => {
    // Awaited so the reply describes the socket rather than the request: the
    // switch in Mission Control paints itself from what comes back, and a bind
    // that failed must not come back looking like a bind that worked.
    await lcServer.setEnabled(on)
    // What is remembered is what was asked for, not what happened. A bind that
    // failed once — userData not writable yet, a stale file we could not remove
    // — should be attempted again next launch, not quietly forgotten.
    saveLcEnabled(on)
    return lcState()
  })
  ipcMain.on(IPC.LcReply, (_e, id: number, res) => lcServer.handleReply(id, res))

  // Terminal copy. xterm's selection lives in a canvas rather than the DOM, so
  // the platform's own copy command finds nothing to put on the clipboard and
  // the renderer has to hand the text over itself.
  ipcMain.on(IPC.ClipboardCopy, (_e, text: string) => {
    if (typeof text === 'string' && text) clipboard.writeText(text)
  })

  // Terminal paste: clipboard images (Snipping Tool / Win+Shift+S) have no
  // file path, so save them to a temp .png and let the renderer paste the path.
  ipcMain.handle(IPC.ClipboardPaste, async (): Promise<ClipboardPasteResult> => {
    // Files copied in Explorer/Finder — paste their real paths. This runs
    // BEFORE the image check on purpose: a copied file often also exposes a
    // thumbnail bitmap, which would otherwise win and paste a temp .png.
    const files = readClipboardFilePaths()
    if (files.length > 0) return { type: 'file', paths: files }
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

/**
 * A clipboard "file path" is only trusted if it carries no control characters.
 * CR/LF would submit a command line when pasted into the terminal, and NUL is
 * never valid in a filename — a hostile app could spoof the file clipboard
 * format with such a string, so drop these before they cross to the renderer.
 */
function safeClipboardPath(p: string): boolean {
  return !/[\r\n\0]/.test(p)
}

/**
 * Paths of files copied to the OS clipboard (Explorer on Windows, Finder on
 * macOS), or [] if the clipboard holds no files. Best-effort and platform-aware.
 */
function readClipboardFilePaths(): string[] {
  try {
    if (process.platform === 'win32') {
      // CF_HDROP surfaces as the 'FileNameW' format: UTF-16LE, one path per
      // file, NUL-separated (a single trailing NUL for one file).
      if (!clipboard.has('FileNameW')) return []
      const buf = clipboard.readBuffer('FileNameW')
      return buf
        .toString('ucs2')
        .split('\0')
        .map((p) => p.trim())
        .filter(Boolean)
        .filter(safeClipboardPath)
    }
    if (process.platform === 'darwin') {
      // Finder exposes copied files as file:// URLs (one per line).
      if (!clipboard.has('public.file-url')) return []
      return clipboard
        .read('public.file-url')
        .split('\n')
        .map((u) => u.trim())
        .filter(Boolean)
        .map((u) => {
          try {
            return decodeURIComponent(new URL(u).pathname)
          } catch {
            return u.replace(/^file:\/\//, '')
          }
        })
        .filter(Boolean)
        .filter(safeClipboardPath)
    }
  } catch {
    // Unsupported format / read failure — fall through to image/text.
  }
  return []
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
  lcServer.setTarget(mainWindow.webContents)
  squadReports.setTarget(mainWindow.webContents)

  // A renderer reload (Ctrl+R / HMR full-reload) respawns every pane with new
  // ids — kill the old ptys so they don't linger as orphans. Fresh spawns
  // rebind their usage watches, so drop the stale ones too.
  mainWindow.webContents.on('did-navigate', () => {
    ptyManager.killAll()
    usageWatcher.unwatchAll()
    // The new page asks again for the folders it still shows.
    squadReports.stopAll()
  })

  // Last line of defence for dropped files: navigating away tears down every
  // terminal in the window, and Chromium's default for a dropped file is to do
  // exactly that. The renderer preventDefaults every drop, so this should never
  // fire — but the cost of it firing is every running Claude session. Reloads
  // navigate to the URL already loaded and stay allowed.
  const wc = mainWindow.webContents
  wc.on('will-navigate', (e, url) => {
    if (url !== wc.getURL()) e.preventDefault()
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
  // Windows shows a notification only when its AppUserModelID matches a Start
  // Menu shortcut, and the NSIS installer writes ours with the appId below —
  // kept in step with electron-builder.yml by hand. Electron sets this itself
  // for Squirrel installs but not for NSIS ones, so without this line every
  // notification the app raises is accepted and then silently dropped.
  if (process.platform === 'win32') app.setAppUserModelId('com.mikhail.lightclaude')

  // Agent hooks, before the first pane spawns: the shell integration files are
  // generated on the first detectShell(), and they only carry the `claude`
  // wrapper if the reporter installed. Failure here is not fatal — the badge
  // falls back to reading transcripts alone, exactly as it did before hooks.
  // Clear out folders belonging to runs that were killed rather than closed,
  // before claiming ours. Only provably dead pids — a live one is a window
  // somebody is using.
  // Only one window may save state.json — it is a whole-window document, and a
  // second saver silently discards the first one's tabs. Claimed before the
  // renderer can ask, so Mission Control's answer is right the first time.
  claimStateOwnership()

  sweepDeadHookDirs()
  const hooks = installHookAssets()
  setHookSettings(hooks?.settings ?? null)
  if (hooks) hookWatcher.start(hooks.spool, (ev) => usageWatcher.applyHook(ev))

  // The lc client is written out every launch. It names no socket of its own —
  // the file is shared by every running instance, so the socket travels in each
  // pane's environment instead, which is the only channel a second Light Code
  // cannot overwrite. The shell function is defined either way: with the switch
  // off the command explains that, which beats "not found".
  const lcInstalled = installLcClient() !== null
  setLcInstalled(lcInstalled)
  ptyManager.setLcSocket(lcInstalled ? socketPath() : null)
  ptyManager.setLcTokens(lcServer)
  void lcServer.setEnabled(loadLcEnabled())

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
  hookWatcher.stop()
  lcServer.stop()
  squadReports.stopAll()
  releaseStateOwnership()
})
