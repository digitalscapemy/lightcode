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
  PtyClaudeActive: 'pty:claude-active',
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
  ClipboardCopy: 'clipboard:copy',
  ClipboardPaste: 'clipboard:paste',
  GitInfo: 'git:info',
  GitWorktreeAdd: 'git:worktree-add',
  GitWorktreeRemove: 'git:worktree-remove',
  GitWorktreePrune: 'git:worktree-prune',
  GitBranchDelete: 'git:branch-delete',
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
 * ~19% of wall-clock. It now comes from Claude Code itself — the
 * PermissionRequest and Notification hooks, via main/agentHooks.ts — and is
 * retired when the tool it guarded produces a result, which is the only proof
 * the prompt was answered. A pane whose shell cannot carry the hooks (fish, nu)
 * simply never reports it, exactly as before.
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

/** Where a pane's directory stands, git-wise. See main/git.ts. */
export interface GitInfo {
  /** False when the directory is not inside a repository at all. */
  repo: boolean
  root: string | null
  /**
   * The repository itself, even when `root` is a linked worktree. Branch work
   * has to happen here: a worktree's own directory stops existing the moment it
   * is removed.
   */
  mainRoot: string | null
  /** Branch name, or null on a detached HEAD, which has none to give. */
  branch: string | null
  /** Tracked files differ from HEAD. Untracked files deliberately don't count. */
  dirty: boolean
  /** A linked worktree rather than the repository itself. */
  worktree: boolean
}

export type WorktreeAddResult =
  | { ok: true; path: string; branch: string }
  | { ok: false; error: string }

export interface BranchDeleteResult {
  ok: boolean
  error?: string
  /** git kept it because it holds commits that are nowhere else. */
  hasWork?: boolean
}

export interface WorktreeRemoveResult {
  ok: boolean
  error?: string
  /** git refused because the worktree still holds work — ask before forcing. */
  needsForce?: boolean
}

export interface UpdateAvailableInfo {
  version: string
  /**
   * What changed in the version being OFFERED, one entry per note, already
   * reduced to plain text. It has to travel with the update: an app's own
   * CHANGELOG was compiled in before the newer version existed, so the running
   * build cannot know what it is being asked to update to. Empty when the
   * release shipped without notes.
   */
  notes: string[]
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
  /** One or more files were copied (Explorer / Finder) — paste their paths. */
  | { type: 'file'; paths: string[] }
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
    /** True while a Claude CLI session is bound to this pane (not at the shell). */
    claudeActive(paneId: string): Promise<boolean>
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
    /** Terminal selection to the OS clipboard. */
    copy(text: string): void
    paste(): Promise<ClipboardPasteResult>
  }
  git: {
    /** Branch, dirty state and whether this is a worktree. Cheap enough to call
     *  whenever a shell prompt renders, which is when it can have changed. */
    info(cwd: string): Promise<GitInfo>
    /** `git worktree add -b <name>` beside the repository. */
    addWorktree(cwd: string, name: string): Promise<WorktreeAddResult>
    /** Without force, git itself refuses to discard uncommitted work. */
    removeWorktree(cwd: string, path: string, force: boolean): Promise<WorktreeRemoveResult>
    /** Forget worktrees whose folders are already gone. Touches no files. */
    pruneWorktrees(cwd: string): Promise<void>
    /** `git branch -d`: refuses anything holding commits of its own. */
    deleteBranch(cwd: string, branch: string): Promise<BranchDeleteResult>
  }
  shortcuts: {
    load(): Promise<ShortcutsConfig>
    /** Saves JSON, rewrites the $PROFILE managed blocks, updates usage roots. */
    save(cfg: ShortcutsConfig): Promise<ShortcutsSaveResult>
    /** Parse-only: reads existing profile functions; no side effects. */
    importFromProfile(): Promise<ShortcutsImportResult>
  }
  /**
   * Absolute path of a File from a drag-and-drop, or '' when it has none.
   * Electron 32 removed File.path; this is the sanctioned replacement.
   */
  filePath(file: File): string
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
