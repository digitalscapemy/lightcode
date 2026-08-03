import { app, ipcMain, Notification, shell } from 'electron'
import type { BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'
import { IPC } from '../shared/ipc'
import type { UpdateCheckStatus } from '../shared/ipc'
import { parseNotes } from './releaseNotes'

const RELEASES_URL = 'https://github.com/digitalscapemy/lightcode/releases/latest'

/**
 * How often a running app looks for a newer release. The check at launch used
 * to be the whole story, which meant a window left open for days never learned
 * about anything published after it started — and this app is built for
 * sessions that stay open for days.
 */
const RECHECK_MS = 4 * 60 * 60 * 1000

/**
 * The macOS installer this machine should run. Getting it wrong is not
 * symmetric — an Intel Mac handed the arm64 build gets an app that will not
 * launch at all — so the choice is made here rather than left to the user.
 * A Rosetta-translated x64 app reports process.arch as x64 but deserves the
 * native build, which is what runningUnderARM64Translation is for.
 */
function macDmgUrl(): string {
  const arm = process.arch === 'arm64' || app.runningUnderARM64Translation === true
  return `${RELEASES_URL}/download/LightCode-${arm ? 'arm64' : 'x64'}.dmg`
}

let getWindow: (() => BrowserWindow | null) | null = null
let checking = false
let downloading = false
let scheduled = false
/** Version the desktop has already been told about — announce once, not hourly. */
let announced: string | null = null

function send(channel: string, ...args: unknown[]): void {
  const wc = getWindow?.()?.webContents
  if (wc && !wc.isDestroyed()) wc.send(channel, ...args)
}

/**
 * Tell the desktop, not just the window. The in-app toast is only ever seen by
 * someone already looking at Light Code, and an update found hours into a
 * session lands behind whatever the user is actually working in.
 *
 * Once per version, never per check: the recheck below would otherwise
 * re-announce the same release every four hours until it was installed.
 */
function announce(version: string): void {
  if (version === announced) return
  announced = version
  // Window already in front: the toast is on screen and says more than a
  // notification could, so this counts as announced and stays that way. Anyone
  // who read the offer and chose "Later" does not need the desktop repeating
  // it hours later — the toast itself comes back every 30 minutes.
  const win = getWindow?.()
  if (win?.isFocused() && !win.isMinimized()) return
  if (!Notification.isSupported()) return

  const note = new Notification({
    title: `Update available — v${version}`,
    body: 'Open Light Code to see what changed and install it.'
  })
  note.on('click', () => {
    const w = getWindow?.()
    if (!w) return
    if (w.isMinimized()) w.restore()
    w.show()
    w.focus()
  })
  note.show()
}

export function initUpdater(windowGetter: () => BrowserWindow | null): void {
  getWindow = windowGetter

  autoUpdater.autoDownload = false
  // Differential downloads don't emit download-progress reliably; the app is
  // small, so always fetch the full installer and keep the progress bar real.
  autoUpdater.disableDifferentialDownload = true

  autoUpdater.on('update-available', (info) => {
    send(IPC.UpdateAvailable, { version: info.version, notes: parseNotes(info.releaseNotes) })
    announce(info.version)
  })
  autoUpdater.on('download-progress', (p) => {
    send(IPC.UpdateProgress, {
      percent: p.percent,
      transferred: p.transferred,
      total: p.total,
      bytesPerSecond: p.bytesPerSecond
    })
  })
  autoUpdater.on('update-downloaded', (e) => {
    send(IPC.UpdateDownloaded, e.version)
    // The NSIS installer is spawned before app.quit(), so the renderer's
    // ≤1s state-flush in the close handler doesn't block installation.
    autoUpdater.quitAndInstall(false, true)
  })
  autoUpdater.on('error', (err) => {
    downloading = false
    console.error('[updater]', err)
    send(IPC.UpdateError, err.message)
  })

  ipcMain.handle(IPC.AppVersion, (): string => app.getVersion())

  ipcMain.handle(IPC.UpdateCheck, async (): Promise<UpdateCheckStatus> => {
    if (!app.isPackaged) return { status: 'dev' }
    if (checking || downloading) return { status: 'none' }
    checking = true
    try {
      const result = await autoUpdater.checkForUpdates()
      if (result?.isUpdateAvailable) {
        return { status: 'available', version: result.updateInfo.version }
      }
      return { status: 'none' }
    } catch (err) {
      return { status: 'error', message: err instanceof Error ? err.message : String(err) }
    } finally {
      checking = false
    }
  })

  ipcMain.on(IPC.UpdateDownload, () => {
    if (process.platform === 'darwin') {
      // Squirrel.Mac refuses unsigned updates — hand off to the browser. Straight
      // to the .dmg this Mac can run, not the releases page: that page asks the
      // user to pick between arm64 and x64, and the app already knows the answer.
      void shell.openExternal(macDmgUrl())
      return
    }
    if (downloading) return
    downloading = true
    autoUpdater.downloadUpdate().catch(() => {
      downloading = false // error event already notified the renderer
    })
  })
}

/** Never two checks at once, and never one on top of a download in flight. */
async function check(): Promise<void> {
  if (checking || downloading) return
  checking = true
  try {
    await autoUpdater.checkForUpdates()
  } catch (err) {
    console.error('[updater]', err)
  } finally {
    checking = false
  }
}

/**
 * Deferred check: runs after the app is up and idle, never at launch — then
 * keeps looking every few hours for as long as the app is open.
 */
export function scheduleUpdateCheck(delayMs = 15_000): void {
  if (!app.isPackaged || scheduled) return
  scheduled = true
  setTimeout(() => {
    void check()
    setInterval(() => void check(), RECHECK_MS)
  }, delayMs)
}
