import type {
  PersistedState,
  ShortcutsConfig,
  ShortcutsImportResult,
  ShortcutsSaveResult
} from './types'

export const IPC = {
  PtySpawn: 'pty:spawn',
  PtyWrite: 'pty:write',
  PtyResize: 'pty:resize',
  PtyKill: 'pty:kill',
  PtyData: 'pty:data',
  PtyExit: 'pty:exit',
  PtyCwd: 'pty:cwd',
  StateLoad: 'state:load',
  StateSave: 'state:save',
  ShortcutsLoad: 'shortcuts:load',
  ShortcutsSave: 'shortcuts:save',
  ShortcutsImport: 'shortcuts:import',
  FlushState: 'app:flush-state',
  FlushDone: 'app:flush-done',
  PickFolder: 'dialog:pickFolder',
  Homedir: 'app:homedir',
  AppVersion: 'app:version',
  UpdateCheck: 'update:check',
  UpdateDownload: 'update:download',
  UpdateAvailable: 'update:available',
  UpdateProgress: 'update:progress',
  UpdateDownloaded: 'update:downloaded',
  UpdateError: 'update:error',
  UsageUpdate: 'usage:update',
  UsageStatus: 'usage:status',
  ClipboardPaste: 'clipboard:paste',
  WinMinimize: 'win:minimize',
  WinMaximize: 'win:maximize',
  WinClose: 'win:close'
} as const

export interface SpawnOptions {
  paneId: string
  cwd: string
  cols: number
  rows: number
}

export interface SpawnResult {
  shell: string
  cwd: string
  /** True when the requested cwd was missing and homedir was used instead. */
  cwdFallback: boolean
}

export interface UsageTotals {
  input: number
  output: number
  cacheRead: number
  cacheCreate: number
}

/** Live token usage of the Claude Code session assigned to one pane. */
export interface UsageUpdate {
  paneId: string
  sessionId: string
  model: string | null
  totals: UsageTotals
  /** Last main-thread assistant message: input + cache read + cache write. */
  contextTokens: number
}

/**
 * Live activity state of the Claude Code session assigned to a pane, derived
 * from its transcript (see usageWatcher):
 *  - `working`          — a turn is under way: the prompt or a tool_result has
 *                         landed and no terminal stop_reason has yet.
 *  - `waiting-input`    — last assistant turn ended (end_turn/stop_sequence);
 *                         Claude is idle, awaiting the user's next prompt.
 *  - `waiting-approval` — Claude is blocked on a permission prompt.
 *  - `idle`             — no active session / neutral.
 *
 * NOTE: `waiting-approval` is never derived from the transcript, because it
 * cannot be: a permission prompt and a ten-minute build are byte-identical
 * there (tool_use, then silence). Guessing from silence made the red dot wrong
 * ~19% of wall-clock. The variant is kept for consumers (babysitter,
 * notifications) and awaits an honest source — Claude Code's Notification hook.
 */
export type PaneStatus = 'working' | 'waiting-input' | 'waiting-approval' | 'idle'

export interface StatusUpdate {
  paneId: string
  status: PaneStatus
  /** Name of the most recent tool Claude invoked (Edit/Bash/…), if any. */
  lastTool: string | null
  /** Timestamp (ms) of the last transcript change for this session. */
  lastActivity: number
}

export interface UpdateAvailableInfo {
  version: string
}

export interface UpdateProgressInfo {
  percent: number
  transferred: number
  total: number
  bytesPerSecond: number
}

export type UpdateCheckStatus =
  | { status: 'available'; version: string }
  | { status: 'none' }
  | { status: 'dev' }
  | { status: 'error'; message: string }

/** Clipboard content resolved for a terminal paste. */
export type ClipboardPasteResult =
  /** An image was on the clipboard — saved to a temp .png. */
  | { type: 'image'; path: string }
  | { type: 'text'; text: string }
  | null

export interface LightClaudeApi {
  /** process.platform — 'win32' | 'darwin' | 'linux' */
  platform: string
  pty: {
    spawn(opts: SpawnOptions): Promise<SpawnResult>
    write(paneId: string, data: string): void
    resize(paneId: string, cols: number, rows: number): void
    kill(paneId: string): void
    onData(cb: (paneId: string, data: string) => void): () => void
    onExit(cb: (paneId: string, exitCode: number) => void): () => void
    /** Live cwd changes from shell integration (`cd` inside the pane). */
    onCwd(cb: (paneId: string, cwd: string) => void): () => void
  }
  state: {
    load(): Promise<PersistedState | null>
    save(state: PersistedState): Promise<void>
    onFlushRequest(cb: () => void): void
    flushDone(): void
  }
  usage: {
    onUpdate(cb: (update: UsageUpdate) => void): () => void
    /** Live per-pane Claude activity state (working / waiting / idle). */
    onStatus(cb: (update: StatusUpdate) => void): () => void
  }
  clipboard: {
    paste(): Promise<ClipboardPasteResult>
  }
  shortcuts: {
    load(): Promise<ShortcutsConfig>
    /** Saves JSON, rewrites the $PROFILE managed blocks, updates usage roots. */
    save(cfg: ShortcutsConfig): Promise<ShortcutsSaveResult>
    /** Parse-only: reads existing profile functions; no side effects. */
    importFromProfile(): Promise<ShortcutsImportResult>
  }
  pickFolder(): Promise<string | null>
  homedir(): Promise<string>
  appVersion(): Promise<string>
  updates: {
    check(): Promise<UpdateCheckStatus>
    /** win32/linux: starts background download; darwin: opens the releases page. */
    download(): void
    onAvailable(cb: (info: UpdateAvailableInfo) => void): () => void
    onProgress(cb: (p: UpdateProgressInfo) => void): () => void
    onDownloaded(cb: (version: string) => void): () => void
    onError(cb: (message: string) => void): () => void
  }
  window: {
    minimize(): void
    maximizeToggle(): void
    close(): void
  }
}
