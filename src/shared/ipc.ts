import type { LcRequest, LcResponse } from './lc'
import type { RolesResult } from './roles'
import type {
  PersistedState,
  ShortcutsConfig,
  ShortcutsImportResult,
  ShortcutsSaveResult
} from './types'
import type { PermissionCheck, SystemPage } from './guides'
import type { ToolStatus } from './tools'
import type { AccountUsage } from './accountUsage'

export const IPC = {
  PtySpawn: 'pty:spawn',
  PtyWrite: 'pty:write',
  PtyResize: 'pty:resize',
  PtyKill: 'pty:kill',
  PtyData: 'pty:data',
  PtyExit: 'pty:exit',
  PtyCwd: 'pty:cwd',
  PtyClaudeActive: 'pty:claude-active',
  PtyAgent: 'pty:agent',
  StateLoad: 'state:load',
  StateSave: 'state:save',
  StateOwned: 'state:owned',
  ShortcutsLoad: 'shortcuts:load',
  ShortcutsSave: 'shortcuts:save',
  ShortcutsImport: 'shortcuts:import',
  FlushState: 'app:flush-state',
  FlushDone: 'app:flush-done',
  PickFolder: 'dialog:pickFolder',
  Homedir: 'app:homedir',
  OpenExternal: 'app:open-external',
  ToolsCheck: 'tools:check',
  PermissionsCheck: 'permissions:check',
  AccountUsage: 'usage:accounts',
  OpenSystemPage: 'app:open-system-page',
  AppVersion: 'app:version',
  RendererReady: 'app:renderer-ready',
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
  GitTree: 'git:tree',
  GitWorktreeCheckout: 'git:worktree-checkout',
  GitFetch: 'git:fetch',
  GitSquadPrepare: 'git:squad-prepare',
  RolesList: 'roles:list',
  AgentResult: 'agent:result',
  AgentAvailable: 'agent:available',
  SquadWatch: 'squad:watch',
  SquadUnwatch: 'squad:unwatch',
  SquadReadReport: 'squad:read-report',
  SquadReport: 'squad:report',
  LcRequest: 'lc:request',
  LcReply: 'lc:reply',
  LcSetEnabled: 'lc:set-enabled',
  LcState: 'lc:state',
  WinMinimize: 'win:minimize',
  WinMaximize: 'win:maximize',
  WinClose: 'win:close'
} as const

export interface SpawnOptions {
  paneId: string
  cwd: string
  cols: number
  rows: number
  /**
   * Squad role for this pane, if it has one.
   *
   * Carried in the pty's environment rather than only on the first `claude`
   * command, because a role that rides the command line evaporates the moment
   * the agent or the user restarts claude, runs /clear, or resumes a session —
   * leaving a pane that still wears its role chip while having forgotten the
   * job. In the environment, the generated `claude` wrapper re-applies it at
   * every launch, for the life of the pane.
   */
  role?: PaneRole
  /**
   * The crew this pane was spawned into, if any.
   *
   * Exported as LIGHTCODE_CREW, LIGHTCODE_HANDLE and LIGHTCODE_LEAD so an agent
   * can tell from its own environment that it conducts or plays in an
   * orchestra, and under what name. A hint, read once at spawn: a pane linked
   * or unlinked later keeps the environment it started with, and `lc`, which
   * asks the app, is the answer that stays current.
   */
  crew?: { id: string; handle: string; lead: boolean }
  /** The agent this pane was opened for, as LIGHTCODE_AGENT. Absent: none named. */
  agent?: string
}

/** What a pane is told about the role it holds. See shared/roles.ts. */
export interface PaneRole {
  id: string
  /** The assembled system prompt: the squad contract plus this role's brief. */
  prompt: string
  /** Where this squad leaves its reports, shared by every pane in it. */
  squadDir: string
}

/** One report in a squad folder's `reports/`, as the watcher lists it. */
export interface SquadReportFile {
  /** The file name, `<role id>.md`. Nothing else in the folder is listed. */
  name: string
  size: number
  /** Last modified, in ms. */
  mtime: number
}

/**
 * Pushed when a squad folder's reports change: every report there now, and
 * which of them are new or rewritten since the last look. A report deleted
 * shows up as a shorter list with nothing in `changed`.
 */
export interface SquadReportUpdate {
  squadDir: string
  reports: SquadReportFile[]
  changed: string[]
}

/** A report's text, read for the viewer. Cut off at 256 KB, and says so. */
export interface SquadReportText {
  name: string
  text: string
  /** The file is larger than what was read. */
  truncated: boolean
  mtime: number
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
  /**
   * Where it came from. Absent means Claude's hooks or transcript, as always.
   * `heuristic` is a guess from an agent's terminal going quiet (see
   * main/quietStatus.ts): shown as ≈, never `waiting-approval`, and nothing
   * acts on it unattended — not the babysitter, not an approve.
   */
  source?: 'hook' | 'transcript' | 'heuristic'
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
  /**
   * How many things git has never been told about, counted the way `git status`
   * counts them — a wholly untracked directory is one entry, `build/`, not the
   * four hundred files inside it.
   *
   * Reported apart from `dirty` because the two are not the same question. A
   * build directory must not light the dirty marker for ever, so it does not;
   * but `git worktree remove` deletes untracked files and the header used to
   * call that directory "clean" right up until it did. Nothing here is allowed
   * to say clean over a file that removing the worktree would destroy.
   */
  untracked: number
  /** A linked worktree rather than the repository itself. */
  worktree: boolean
}

/**
 * Where a branch stands, locally and on the remote.
 *
 * Everything here is read with plumbing commands and nothing is inferred. Two
 * measurements, because they answer two different questions: `ahead`/`behind`
 * are against the base branch ("has this reached main yet"), and the upstream
 * counts are against the remote branch it tracks ("has this reached GitHub
 * yet"), as of the last fetch.
 */
export interface GitBranchState {
  /** Commits this branch has that the base does not. */
  ahead: number
  /** Commits the base has that this branch does not. */
  behind: number
  /** The remote branch it tracks, `origin/feat`. Null when it was never pushed. */
  upstream: string | null
  /** Commits not pushed yet. */
  upstreamAhead: number
  /** Commits on the remote not pulled yet, as of the last fetch. */
  upstreamBehind: number
  /** It tracks a remote branch that has since been deleted. */
  upstreamGone: boolean
}

/** A branch no worktree is sitting in, listed below the worktrees. */
export interface GitBranchRow extends GitBranchState {
  branch: string
  head: string
  /** First line of the tip commit's message. */
  subject: string
  /** Tip commit date, ISO 8601, for a relative label in the panel. */
  when: string
}

/** One checkout of the repository — its own, or a linked worktree. */
export interface GitWorktreeRow extends GitBranchState {
  path: string
  /** Branch checked out there, or null on a detached HEAD. */
  branch: string | null
  head: string
  subject: string
  when: string
  /** Tracked changes there. Null when the folder is gone and cannot be read. */
  dirty: boolean | null
  /** Untracked entries there, counted as `git status` counts them. */
  untracked: number | null
  /** The repository's own checkout rather than a linked worktree. */
  isMain: boolean
  /** Locked with `git worktree lock`; git will not remove it. */
  locked: boolean
  /** Its folder has been deleted; only git's record of it is left. */
  prunable: boolean
}

/** Every worktree of one repository, and the branches none of them hold. */
export interface GitTree {
  /** The repository itself, never a linked worktree. */
  root: string
  /** main, master, or whatever origin/HEAD points at. */
  base: string
  /** The remote fetched from and pushed to. Null when the repository has none. */
  remote: string | null
  /** When anything last fetched here, ISO 8601. Null if nothing ever has. */
  lastFetch: string | null
  /** The repository's own checkout first, then linked worktrees, newest first. */
  worktrees: GitWorktreeRow[]
  /** Local branches no worktree has checked out, newest first. */
  branches: GitBranchRow[]
  /**
   * A merge is half-finished somewhere in the repository's own checkout.
   *
   * Integrate stops on this rather than pressing on: the next merge would run
   * against a conflicted tree, and the honest place to finish the first one is
   * the terminal it was started in.
   */
  mergeInProgress: boolean
}

export type WorktreeAddResult =
  | { ok: true; path: string; branch: string }
  | { ok: false; error: string }

export interface FetchResult {
  ok: boolean
  /** git's own sentence: offline, authentication refused, remote not found. */
  error?: string
}

export interface BranchDeleteResult {
  ok: boolean
  error?: string
  /** git kept it because it holds commits that are nowhere else. */
  hasWork?: boolean
}

/**
 * What is in a worktree that removing it would take with it.
 *
 * Split in two because only one half is recoverable. A modified tracked file
 * still has its committed version on the branch; an untracked file exists on
 * disk and nowhere else — no index, no object database, no branch — so deleting
 * the folder is the end of it. A dialog that calls both "uncommitted changes"
 * offers the same reassurance about both, and it is only true of one.
 */
export interface PendingWork {
  /** Tracked files that differ from HEAD, staged or not. */
  modified: string[]
  /** Paths git has never been told about, `build/` counting once. */
  untracked: string[]
}

export interface WorktreeRemoveResult {
  ok: boolean
  error?: string
  /** git refused because the worktree still holds work — ask before forcing. */
  needsForce?: boolean
  /** Exactly what forcing would destroy, so the question can name it. */
  pending?: PendingWork
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
    /**
     * The agent this pane now runs, when it changed after the pane was spawned
     * ("Agent ▸"). Main guesses at the status of an agent without hooks.
     */
    setAgent(paneId: string, agent: string | null): void
  }
  state: {
    load(): Promise<PersistedState | null>
    save(state: PersistedState): Promise<void>
    onFlushRequest(cb: () => void): void
    flushDone(): void
    /**
     * False when another running Light Code owns state.json and this window's
     * layout is therefore not being remembered. Mission Control says so; a
     * window that quietly stopped saving its tabs is worse than one that admits
     * it. See main/stateStore.ts.
     */
    owned(): Promise<boolean>
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
    /** Every worktree and branch, against the base and the remote. Read-only. */
    tree(cwd: string): Promise<GitTree | null>
    /** `git worktree add` for a branch that already exists. */
    checkoutWorktree(cwd: string, branch: string): Promise<WorktreeAddResult>
    /** `git fetch --all --prune`, never prompting for credentials. */
    fetch(cwd: string): Promise<FetchResult>
    /** Make the folder a squad shares, beside the repo. Null if not in one. */
    prepareSquad(cwd: string, task: string): Promise<string | null>
  }
  roles: {
    /** Built-in squad roles, with `.lightcode/roles.json` applied when present. */
    list(cwd: string): Promise<RolesResult>
  }
  agent: {
    /**
     * The last answer of the Claude session bound to this pane, from its
     * transcript. Null when no session is bound or it has said nothing yet.
     */
    result(paneId: string): Promise<string | null>
    /**
     * Which agents' commands are on PATH, by adapter id. An agent with no
     * command (the shell) is always available. Read once and cached by main.
     */
    available(): Promise<Record<string, boolean>>
  }
  /**
   * The reports a squad files into its folder. Main refuses any folder that
   * is not one a squad uses (see main/squadReports.ts), so these answer null
   * rather than read an arbitrary directory.
   */
  squad: {
    /** Start watching a squad folder's reports; the current list, or null if refused. */
    watch(squadDir: string): Promise<SquadReportFile[] | null>
    unwatch(squadDir: string): void
    readReport(squadDir: string, name: string): Promise<SquadReportText | null>
    onReport(cb: (update: SquadReportUpdate) => void): () => void
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
  /** Open a terminal link in the default browser (http/https/mailto only). */
  openExternal(url: string): void
  /** Which agent CLIs are installed (fresh PATH, versions). */
  checkTools(): Promise<ToolStatus[]>
  /** What Light Code may write, and what it needs installed. */
  checkPermissions(): Promise<PermissionCheck[]>
  /** Token usage per Claude account, today and the last 7 days. */
  accountUsage(): Promise<AccountUsage[]>
  /** Open one of a fixed set of OS settings pages, for a guide step. */
  openSystemPage(page: SystemPage): void
  appVersion(): Promise<string>
  /** The first real screen is painted: the window may be shown. */
  rendererReady(): void
  updates: {
    check(): Promise<UpdateCheckStatus>
    /** win32/linux: starts background download; darwin: opens the releases page. */
    download(): void
    onAvailable(cb: (info: UpdateAvailableInfo) => void): () => void
    onProgress(cb: (p: UpdateProgressInfo) => void): () => void
    onDownloaded(cb: (version: string) => void): () => void
    onError(cb: (message: string) => void): () => void
  }
  /** The `lc` agent CLI — off until switched on. See main/lcServer.ts. */
  lc: {
    /** Whether the socket is listening, and where the shell function finds it. */
    state(): Promise<{ enabled: boolean; command: string }>
    setEnabled(on: boolean): Promise<{ enabled: boolean; command: string }>
    /** A request forwarded from the socket, to be answered with reply(). */
    onRequest(cb: (id: number, req: LcRequest) => void): () => void
    reply(id: number, res: LcResponse): void
  }
  window: {
    minimize(): void
    maximizeToggle(): void
    close(): void
  }
}
