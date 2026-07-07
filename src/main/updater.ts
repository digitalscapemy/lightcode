import { app, ipcMain, shell } from 'electron'
import type { BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'
import { IPC } from '../shared/ipc'
import type { UpdateCheckStatus } from '../shared/ipc'

const RELEASES_URL = 'https://github.com/digitalscapemy/lightcode/releases/latest'

let getWindow: (() => BrowserWindow | null) | null = null
let checking = false
let downloading = false
let scheduled = false

function send(channel: string, ...args: unknown[]): void {
  const wc = getWindow?.()?.webContents
  if (wc && !wc.isDestroyed()) wc.send(channel, ...args)
}

export function initUpdater(windowGetter: () => BrowserWindow | null): void {
  getWindow = windowGetter

  autoUpdater.autoDownload = false
  // Differential downloads don't emit download-progress reliably; the app is
  // small, so always fetch the full installer and keep the progress bar real.
  autoUpdater.disableDifferentialDownload = true

  autoUpdater.on('update-available', (info) => {
    send(IPC.UpdateAvailable, { version: info.version })
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
    if (checking) return { status: 'none' }
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
      // Squirrel.Mac refuses unsigned updates — hand off to the browser.
      void shell.openExternal(RELEASES_URL)
      return
    }
    if (downloading) return
    downloading = true
    autoUpdater.downloadUpdate().catch(() => {
      downloading = false // error event already notified the renderer
    })
  })
}

/** Deferred check: runs after the app is up and idle, never at launch. */
export function scheduleUpdateCheck(delayMs = 15_000): void {
  if (!app.isPackaged || scheduled) return
  scheduled = true
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch((err) => console.error('[updater]', err))
  }, delayMs)
}
