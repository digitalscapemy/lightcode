import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import { IPC } from '../shared/ipc'
import type {
  LightClaudeApi,
  SpawnOptions,
  StatusUpdate,
  UpdateAvailableInfo,
  UpdateProgressInfo,
  UsageUpdate
} from '../shared/ipc'
import type { PersistedState, ShortcutsConfig } from '../shared/types'

const api: LightClaudeApi = {
  platform: process.platform,
  pty: {
    spawn: (opts: SpawnOptions) => ipcRenderer.invoke(IPC.PtySpawn, opts),
    write: (paneId, data) => ipcRenderer.send(IPC.PtyWrite, paneId, data),
    resize: (paneId, cols, rows) => ipcRenderer.send(IPC.PtyResize, paneId, cols, rows),
    kill: (paneId) => ipcRenderer.send(IPC.PtyKill, paneId),
    onData: (cb) => {
      const listener = (_e: IpcRendererEvent, paneId: string, data: string): void => cb(paneId, data)
      ipcRenderer.on(IPC.PtyData, listener)
      return () => ipcRenderer.removeListener(IPC.PtyData, listener)
    },
    onExit: (cb) => {
      const listener = (_e: IpcRendererEvent, paneId: string, exitCode: number): void => cb(paneId, exitCode)
      ipcRenderer.on(IPC.PtyExit, listener)
      return () => ipcRenderer.removeListener(IPC.PtyExit, listener)
    },
    onCwd: (cb) => {
      const listener = (_e: IpcRendererEvent, paneId: string, cwd: string): void => cb(paneId, cwd)
      ipcRenderer.on(IPC.PtyCwd, listener)
      return () => ipcRenderer.removeListener(IPC.PtyCwd, listener)
    },
    claudeActive: (paneId) => ipcRenderer.invoke(IPC.PtyClaudeActive, paneId)
  },
  state: {
    load: (): Promise<PersistedState | null> => ipcRenderer.invoke(IPC.StateLoad),
    save: (state: PersistedState) => ipcRenderer.invoke(IPC.StateSave, state),
    onFlushRequest: (cb) => {
      ipcRenderer.on(IPC.FlushState, () => cb())
    },
    flushDone: () => ipcRenderer.send(IPC.FlushDone)
  },
  usage: {
    onUpdate: (cb) => {
      const listener = (_e: IpcRendererEvent, update: UsageUpdate): void => cb(update)
      ipcRenderer.on(IPC.UsageUpdate, listener)
      return () => ipcRenderer.removeListener(IPC.UsageUpdate, listener)
    },
    onStatus: (cb) => {
      const listener = (_e: IpcRendererEvent, update: StatusUpdate): void => cb(update)
      ipcRenderer.on(IPC.UsageStatus, listener)
      return () => ipcRenderer.removeListener(IPC.UsageStatus, listener)
    }
  },
  clipboard: {
    paste: () => ipcRenderer.invoke(IPC.ClipboardPaste)
  },
  shortcuts: {
    load: () => ipcRenderer.invoke(IPC.ShortcutsLoad),
    save: (cfg: ShortcutsConfig) => ipcRenderer.invoke(IPC.ShortcutsSave, cfg),
    importFromProfile: () => ipcRenderer.invoke(IPC.ShortcutsImport)
  },
  pickFolder: () => ipcRenderer.invoke(IPC.PickFolder),
  homedir: () => ipcRenderer.invoke(IPC.Homedir),
  appVersion: () => ipcRenderer.invoke(IPC.AppVersion),
  updates: {
    check: () => ipcRenderer.invoke(IPC.UpdateCheck),
    download: () => ipcRenderer.send(IPC.UpdateDownload),
    onAvailable: (cb) => {
      const listener = (_e: IpcRendererEvent, info: UpdateAvailableInfo): void => cb(info)
      ipcRenderer.on(IPC.UpdateAvailable, listener)
      return () => ipcRenderer.removeListener(IPC.UpdateAvailable, listener)
    },
    onProgress: (cb) => {
      const listener = (_e: IpcRendererEvent, p: UpdateProgressInfo): void => cb(p)
      ipcRenderer.on(IPC.UpdateProgress, listener)
      return () => ipcRenderer.removeListener(IPC.UpdateProgress, listener)
    },
    onDownloaded: (cb) => {
      const listener = (_e: IpcRendererEvent, version: string): void => cb(version)
      ipcRenderer.on(IPC.UpdateDownloaded, listener)
      return () => ipcRenderer.removeListener(IPC.UpdateDownloaded, listener)
    },
    onError: (cb) => {
      const listener = (_e: IpcRendererEvent, message: string): void => cb(message)
      ipcRenderer.on(IPC.UpdateError, listener)
      return () => ipcRenderer.removeListener(IPC.UpdateError, listener)
    }
  },
  window: {
    minimize: () => ipcRenderer.send(IPC.WinMinimize),
    maximizeToggle: () => ipcRenderer.send(IPC.WinMaximize),
    close: () => ipcRenderer.send(IPC.WinClose)
  }
}

contextBridge.exposeInMainWorld('lightclaude', api)
