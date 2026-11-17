import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { IpcRendererEvent } from 'electron'
import { IPC } from '../shared/ipc'
import type {
  LightClaudeApi,
  SpawnOptions,
  SquadReportUpdate,
  StatusUpdate,
  UpdateAvailableInfo,
  UpdateProgressInfo,
  UsageUpdate
} from '../shared/ipc'
import type { LcRequest, LcResponse } from '../shared/lc'
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
    claudeActive: (paneId) => ipcRenderer.invoke(IPC.PtyClaudeActive, paneId),
    setAgent: (paneId, agent) => ipcRenderer.send(IPC.PtyAgent, paneId, agent)
  },
  state: {
    load: (): Promise<PersistedState | null> => ipcRenderer.invoke(IPC.StateLoad),
    save: (state: PersistedState) => ipcRenderer.invoke(IPC.StateSave, state),
    owned: () => ipcRenderer.invoke(IPC.StateOwned),
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
    copy: (text: string) => ipcRenderer.send(IPC.ClipboardCopy, text),
    paste: () => ipcRenderer.invoke(IPC.ClipboardPaste)
  },
  shortcuts: {
    load: () => ipcRenderer.invoke(IPC.ShortcutsLoad),
    save: (cfg: ShortcutsConfig) => ipcRenderer.invoke(IPC.ShortcutsSave, cfg),
    importFromProfile: () => ipcRenderer.invoke(IPC.ShortcutsImport)
  },
  git: {
    info: (cwd: string) => ipcRenderer.invoke(IPC.GitInfo, cwd),
    addWorktree: (cwd: string, name: string) => ipcRenderer.invoke(IPC.GitWorktreeAdd, cwd, name),
    removeWorktree: (cwd: string, path: string, force: boolean) =>
      ipcRenderer.invoke(IPC.GitWorktreeRemove, cwd, path, force),
    pruneWorktrees: (cwd: string) => ipcRenderer.invoke(IPC.GitWorktreePrune, cwd),
    deleteBranch: (cwd: string, branch: string) =>
      ipcRenderer.invoke(IPC.GitBranchDelete, cwd, branch),
    tree: (cwd: string) => ipcRenderer.invoke(IPC.GitTree, cwd),
    checkoutWorktree: (cwd: string, branch: string) =>
      ipcRenderer.invoke(IPC.GitWorktreeCheckout, cwd, branch),
    fetch: (cwd: string) => ipcRenderer.invoke(IPC.GitFetch, cwd),
    prepareSquad: (cwd: string, task: string) =>
      ipcRenderer.invoke(IPC.GitSquadPrepare, cwd, task)
  },
  roles: {
    list: (cwd: string) => ipcRenderer.invoke(IPC.RolesList, cwd)
  },
  agent: {
    result: (paneId: string) => ipcRenderer.invoke(IPC.AgentResult, paneId),
    available: () => ipcRenderer.invoke(IPC.AgentAvailable)
  },
  squad: {
    watch: (squadDir: string) => ipcRenderer.invoke(IPC.SquadWatch, squadDir),
    unwatch: (squadDir: string) => ipcRenderer.send(IPC.SquadUnwatch, squadDir),
    readReport: (squadDir: string, name: string) =>
      ipcRenderer.invoke(IPC.SquadReadReport, squadDir, name),
    onReport: (cb) => {
      const listener = (_e: IpcRendererEvent, update: SquadReportUpdate): void => cb(update)
      ipcRenderer.on(IPC.SquadReport, listener)
      return () => ipcRenderer.removeListener(IPC.SquadReport, listener)
    }
  },
  // Electron 32 removed File.path, so webUtils is the only route from a dropped
  // File to its real path. Returns '' for a File the OS gave no path (dragged
  // out of a web page) and for anything that isn't a File at all.
  filePath: (file: File) => {
    try {
      return webUtils.getPathForFile(file)
    } catch {
      return ''
    }
  },
  pickFolder: () => ipcRenderer.invoke(IPC.PickFolder),
  homedir: () => ipcRenderer.invoke(IPC.Homedir),
  openExternal: (url) => ipcRenderer.send(IPC.OpenExternal, url),
  checkTools: () => ipcRenderer.invoke(IPC.ToolsCheck),
  checkPermissions: () => ipcRenderer.invoke(IPC.PermissionsCheck),
  openSystemPage: (page) => ipcRenderer.send(IPC.OpenSystemPage, page),
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
  lc: {
    state: () => ipcRenderer.invoke(IPC.LcState),
    setEnabled: (on: boolean) => ipcRenderer.invoke(IPC.LcSetEnabled, on),
    onRequest: (cb) => {
      const listener = (_e: IpcRendererEvent, id: number, req: LcRequest): void => cb(id, req)
      ipcRenderer.on(IPC.LcRequest, listener)
      return () => ipcRenderer.removeListener(IPC.LcRequest, listener)
    },
    reply: (id: number, res: LcResponse) => ipcRenderer.send(IPC.LcReply, id, res)
  },
  window: {
    minimize: () => ipcRenderer.send(IPC.WinMinimize),
    maximizeToggle: () => ipcRenderer.send(IPC.WinMaximize),
    close: () => ipcRenderer.send(IPC.WinClose)
  }
}

contextBridge.exposeInMainWorld('lightclaude', api)
