import type { WebContents } from 'electron'
import { watch } from 'fs'
import type { FSWatcher, Stats } from 'fs'
import { open, readdir, stat } from 'fs/promises'
import { homedir } from 'os'
import { basename, dirname, join } from 'path'
import { StringDecoder } from 'string_decoder'
import { IPC } from '../shared/ipc'
import type { PaneStatus, StatusUpdate, UsageTotals, UsageUpdate } from '../shared/ipc'
import { statusForEvent } from './agentHooks'
import type { HookEvent } from './agentHooks'

const DEBOUNCE_MS = 150
const POLL_MS = 3000
const READ_CHUNK = 256 * 1024
/** A NEW session file only binds to a pane that had input this recently. */
const ASSIGN_WINDOW_MS = 60_000
/** A pre-existing file (--resume) needs much fresher input to be claimed. */
const RESUME_WINDOW_MS = 15_000
/** A pane whose session updated this recently is mid-conversation — its
 *  badge must not be stolen by other sessions changing in the same folder. */
const SESSION_ACTIVE_MS = 5_000

/**
 * Where the main-thread conversation is.
 *
 * Status used to be timing-based: "transcript silent for 4s ⇒ not working".
 * That is backwards — the transcript is silent *precisely while* work happens
 * (model thinking, tool running), so silence carries no information at all.
 * Replaying that rule over real transcripts put it wrong 30% of wall-clock.
 * A turn runs from the human prompt until a terminal stop_reason lands, and
 * only lines move it.
 */
type TurnPhase = 'none' | 'active' | 'ended'

/** Claude Code's transcript folder for a project cwd under one config root. */
function transcriptDir(configRoot: string, projectPath: string): string {
  return join(configRoot, 'projects', projectPath.replace(/[^a-zA-Z0-9]/g, '-'))
}

/** Default config root — always watched even with no accounts configured. */
function defaultRoot(): string {
  return join(homedir(), '.claude')
}

function normalizeRoot(dir: string): string {
  return dir.replace(/[\\/]+$/, '')
}

function watchKey(root: string, projectPath: string): string {
  return `${root}\u0000${projectPath}`
}

function emptyTotals(): UsageTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 }
}

/**
 * Pending permission prompts on one pane, reported by the PermissionRequest and
 * Notification hooks. Held outside FileState because the transcript knows
 * nothing about them.
 *
 * Measured against Claude Code 2.1.226: PermissionRequest carries `tool_name`
 * but NOT `tool_use_id`, so a prompt cannot be tied to the exact call it guards.
 * What can be counted is answers — every prompt, approved or denied, produces
 * one tool_result in the transcript. So a prompt is retired by arithmetic:
 * enough results have landed to have answered every prompt raised.
 */
export interface Approval {
  toolName: string | null
  /** state.toolResults when the first prompt of this batch appeared. */
  results: number
  /**
   * How many PermissionRequest hooks are unanswered. Claude batches tool calls
   * and raises one prompt per call; clearing on the first result would put the
   * dot out while the user still has prompts in front of them.
   *
   * Zero means the prompt came from a Notification alone, which is not counted
   * — it fires alongside PermissionRequest and would double-count it. Such a
   * prompt retires on any new result.
   */
  outstanding: number
}

/** Incremental parse state for one session .jsonl. */
export interface FileState {
  offset: number
  decoder: StringDecoder
  remainder: string
  /** Dedupe: `${requestId}|${message.id}` — streaming rewrites the same message. */
  seen: Map<string, UsageTotals>
  totals: UsageTotals
  contextTokens: number
  model: string | null
  /** Status signal: where the main-thread conversation is. */
  phase: TurnPhase
  /** Name of the most recent tool_use block Claude emitted. */
  lastTool: string | null
  /**
   * How many tool_result blocks have landed. A pending permission prompt is
   * resolved the moment the tool it was guarding produces a result, and this
   * counter is what says so without consulting a clock.
   */
  toolResults: number
}

/**
 * Have all the prompts raised on this pane been answered? Every answer, yes or
 * no, appends one tool_result, so the test is whether that many have landed
 * since the first prompt appeared.
 *
 * No transcript yet means no: a prompt is on screen and nothing can have
 * answered it.
 */
export function approvalResolved(pending: Approval, state: FileState | undefined): boolean {
  if (!state) return false
  return state.toolResults >= pending.results + Math.max(1, pending.outstanding)
}

/**
 * What a pane should show, given everything known about it — the whole
 * precedence rule in one pure place, because it is now three deep:
 *
 *  1. An unanswered permission prompt. Nothing outranks it: it is the one state
 *     the transcript provably cannot see.
 *  2. A turn Claude Code said had ended. The transcript may not re-open it — a
 *     turn whose tools were all rejected ends on a tool_result, which inference
 *     reads as a turn *starting*, leaving a busy pill on an idle Claude.
 *  3. Otherwise the transcript, which is right about everything else.
 */
export function statusFor(
  pending: Approval | undefined,
  turn: 'working' | 'ended' | undefined,
  state: FileState
): PaneStatus {
  if (pending && !approvalResolved(pending, state)) return 'waiting-approval'
  if (turn === 'ended') return 'waiting-input'
  return deriveStatus(state)
}

export function emptyFileState(): FileState {
  return {
    offset: 0,
    decoder: new StringDecoder('utf8'),
    remainder: '',
    seen: new Map(),
    totals: emptyTotals(),
    contextTokens: 0,
    model: null,
    phase: 'none',
    lastTool: null,
    toolResults: 0
  }
}

interface ProjectWatch {
  projectPath: string
  root: string
  dir: string
  panes: Set<string>
  watcher: FSWatcher | null
  pollTimer: NodeJS.Timeout
  debounce: NodeJS.Timeout | null
  refreshing: boolean
  dirty: boolean
  /** file path -> last seen stat, to spot changed sessions on each pass. */
  stats: Map<string, { mtime: number; size: number }>
  /** Parse state for ASSIGNED session files only. */
  files: Map<string, FileState>
  /** First successful scan only inventories pre-existing sessions. */
  primed: boolean
}

/**
 * Tails Claude Code session transcripts (~/.claude/projects/<encoded-cwd>/)
 * and pushes real token usage to the renderer, PER PANE.
 *
 * Attribution: panes are bound to their live cwd (shell integration reports
 * `cd`s via OSC 9;9 — see shell.ts / ptyManager). When a session file in that
 * project starts changing, it is assigned to the pane that most recently had
 * keyboard input — the pane where the user actually launched `claude`.
 * Sessions from terminals outside this app never get a badge.
 */
export class UsageWatcher {
  private projects = new Map<string, ProjectWatch>() // watchKey(root, project) -> watch
  private roots: string[] = [defaultRoot()] // claude config roots to scan
  private paneProject = new Map<string, string>() // paneId -> projectPath
  private paneSession = new Map<string, string>() // paneId -> session file
  private sessionPane = new Map<string, string>() // session file -> paneId
  private lastInput = new Map<string, number>() // paneId -> ts of last keystroke
  private lastPushed = new Map<string, string>() // paneId -> last payload
  private lastStatus = new Map<string, string>() // paneId -> last status payload
  private sessionActivity = new Map<string, number>() // session file -> last change ts
  private paneApproval = new Map<string, Approval>() // paneId -> pending permission prompt
  /**
   * Panes whose Claude announces itself through the agent hooks.
   *
   * For these, attribution is a fact and guessing is not just unnecessary but
   * harmful: pickPane would hand a foreign session — one running in a terminal
   * outside this app, in the same folder — to whichever pane last had a
   * keystroke, overwriting the binding a SessionStart hook established. That is
   * how a pane running a 30k conversation ends up displaying someone else's
   * 300k one.
   *
   * Sticky for the pane's lifetime rather than the session's: a pane sitting at
   * a shell prompt has no session to show and must not be given one either.
   * Panes in a shell the wrapper cannot reach (fish, nu) never appear here and
   * keep the keystroke heuristic, which is all they ever had.
   */
  private hookPanes = new Set<string>()
  /**
   * Where the turn is, according to Claude Code itself.
   *
   * The transcript cannot always tell. A turn whose tools were all rejected
   * ends on a tool_result, and a tool_result is what *opens* a turn — so
   * inference reads "working" and stays there, showing a busy pill for a Claude
   * that finished half a minute ago. The Stop hook knows better.
   *
   * Only 'ended' overrides inference, and only in that direction: a turn the
   * hook ended is over, full stop. While 'working', the transcript still gets
   * to end the turn on its own, so a lost envelope cannot freeze a pane.
   */
  private paneTurn = new Map<string, 'working' | 'ended'>()
  private target: WebContents | null = null

  setTarget(wc: WebContents): void {
    this.target = wc
  }

  /**
   * Multi-account support: transcripts live under each account's
   * CLAUDE_CONFIG_DIR. The default ~/.claude is always included.
   */
  setConfigRoots(accountDirs: string[]): void {
    const next: string[] = [defaultRoot()]
    const seen = new Set([defaultRoot().toLowerCase()])
    for (const dir of accountDirs) {
      const norm = normalizeRoot(dir.trim())
      if (!norm) continue
      const key = norm.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      next.push(norm)
    }
    const removed = this.roots.filter((r) => !seen.has(r.toLowerCase()))
    const added = next.filter(
      (r) => !this.roots.some((old) => old.toLowerCase() === r.toLowerCase())
    )
    this.roots = next

    for (const root of removed) {
      for (const [key, watch] of [...this.projects]) {
        if (watch.root.toLowerCase() !== root.toLowerCase()) continue
        this.disposeWatch(watch)
        this.projects.delete(key)
      }
    }
    for (const root of added) {
      for (const [paneId, projectPath] of this.paneProject) {
        this.joinWatch(paneId, root, projectPath)
      }
    }
  }

  /** Called for every user keystroke; feeds session→pane attribution. */
  noteInput(paneId: string): void {
    this.lastInput.set(paneId, Date.now())
  }

  /**
   * A lifecycle event straight from Claude Code (see agentHooks.ts). Hooks are
   * additive, never a replacement for the transcript: they contribute the two
   * facts it has no way to carry — which pane a session belongs to, and whether
   * a permission prompt is on screen.
   */
  applyHook(ev: HookEvent): void {
    // A pane we are not running: a stale envelope, or a session in someone
    // else's terminal that happened to inherit the variable.
    if (!this.paneProject.has(ev.paneId)) return

    // Any event at all proves this pane's Claude reports itself, so the
    // keystroke heuristic must never speak for it again.
    this.hookPanes.add(ev.paneId)

    if (ev.event === 'SessionStart') {
      if (ev.transcriptPath) this.bindSession(ev.paneId, ev.transcriptPath)
      return // deliberately no status: see statusForEvent
    }

    if (ev.event === 'SessionEnd') {
      this.paneApproval.delete(ev.paneId)
      this.endSession(ev.paneId)
      return
    }

    const status = statusForEvent(ev)
    if (status === null) return // subagent traffic, or a non-permission notification

    if (status === 'waiting-approval') {
      const session = this.paneSession.get(ev.paneId)
      const state = session ? this.stateFor(session) : undefined
      const open = this.paneApproval.get(ev.paneId)
      const prior = open?.outstanding ?? 0
      // Only PermissionRequest is counted. Notification fires alongside it for
      // the same prompt, so counting both would demand two answers to one
      // question and hold the dot red until the turn ended. A Notification
      // arriving first leaves `prior` at 0, which the request then takes to 1
      // rather than 2.
      const outstanding =
        ev.event === 'PermissionRequest' ? (prior === 0 ? 1 : prior + 1) : prior
      const pending: Approval = {
        toolName: ev.toolName ?? open?.toolName ?? null,
        // The snapshot belongs to the first prompt of the batch, not the latest.
        results: open?.results ?? state?.toolResults ?? 0,
        outstanding
      }
      this.paneApproval.set(ev.paneId, pending)
      this.pushStatus(ev.paneId, status, pending.toolName ?? state?.lastTool ?? null, Date.now())
      return
    }

    // A prompt submitted or a turn ended settles any prompt that was pending.
    this.paneApproval.delete(ev.paneId)
    this.paneTurn.set(ev.paneId, status === 'working' ? 'working' : 'ended')
    const session = this.paneSession.get(ev.paneId)
    const state = session ? this.stateFor(session) : undefined
    this.pushStatus(ev.paneId, status, state?.lastTool ?? null, Date.now())
  }

  /**
   * Bind a pane to the transcript Claude Code named, rather than to whichever
   * session started changing while that pane happened to have the most recent
   * keystroke. Where the hook fires, attribution stops being a guess.
   */
  private bindSession(paneId: string, file: string): void {
    if (this.paneSession.get(paneId) === file) return

    const previous = this.paneSession.get(paneId)
    if (previous) {
      this.sessionPane.delete(previous)
      this.sessionActivity.delete(previous)
    }
    // Whoever held this transcript before does not any more.
    const holder = this.sessionPane.get(file)
    if (holder !== undefined && holder !== paneId) this.paneSession.delete(holder)

    this.paneSession.set(paneId, file)
    this.sessionPane.set(file, paneId)
    this.paneApproval.delete(paneId)

    // Usually already watched, since the pane's cwd resolves to this very
    // folder. It will not be when the session lives under a config root the
    // Shortcuts list never mentioned — an account the user runs by hand. The
    // hook tells us where to look, so watch it.
    const dir = dirname(file)
    let watch = this.findWatchByDir(dir)
    if (!watch) {
      watch = this.createWatch('', '', dir)
      // Keyed by the folder itself. It cannot collide with a cwd-derived key,
      // which carries a NUL separator no path can contain.
      this.projects.set(dir, watch)
    }
    watch.panes.add(paneId)
    // Registering the parse state is what makes scan() read this transcript
    // from the top on its very first pass, priming or not — see the note there.
    if (!watch.files.has(file)) watch.files.set(file, emptyFileState())
    this.schedule(watch)
  }

  /** The CLI exited: drop the binding and put the dot out. */
  private endSession(paneId: string): void {
    this.paneTurn.delete(paneId)
    const session = this.paneSession.get(paneId)
    if (session) {
      this.paneSession.delete(paneId)
      this.sessionPane.delete(session)
      this.sessionActivity.delete(session)
    }
    this.pushStatus(paneId, 'idle', null, Date.now())
    this.lastPushed.delete(paneId)
  }

  private findWatchByDir(dir: string): ProjectWatch | undefined {
    for (const watch of this.projects.values()) if (watch.dir === dir) return watch
    return undefined
  }

  /** Parse state of a session file, wherever it is being watched. */
  private stateFor(file: string): FileState | undefined {
    return this.findWatchByDir(dirname(file))?.files.get(file)
  }

  /**
   * True while a Claude session is bound to this pane — i.e. claude is running,
   * not sitting at the shell prompt. The binding is torn down by notePrompt()
   * (shell prompt rendered) and unbindPane(), so it tracks the CLI's lifetime.
   */
  hasSession(paneId: string): boolean {
    return this.paneSession.has(paneId)
  }

  /**
   * The transcript file of the session bound to this pane, or null. What
   * `lc result` reads the pane's last answer from; see agentResult.ts.
   */
  transcriptFor(paneId: string): string | null {
    return this.paneSession.get(paneId) ?? null
  }

  /** Point a pane at its current directory; called on spawn and on every cd. */
  bindPane(paneId: string, projectPath: string): void {
    const prev = this.paneProject.get(paneId)
    if (prev === projectPath) return
    if (prev !== undefined) this.leaveProject(paneId, prev)
    this.paneProject.set(paneId, projectPath)
    for (const root of this.roots) this.joinWatch(paneId, root, projectPath)
  }

  private joinWatch(paneId: string, root: string, projectPath: string): void {
    const key = watchKey(root, projectPath)
    let watch = this.projects.get(key)
    if (!watch) {
      watch = this.createWatch(root, projectPath)
      this.projects.set(key, watch)
    }
    watch.panes.add(paneId)
    this.schedule(watch)
  }

  unbindPane(paneId: string): void {
    this.paneApproval.delete(paneId)
    this.paneTurn.delete(paneId)
    // Push the final idle FIRST: the teardown below erases the mapping
    // pushStatus needs, and without it the renderer keeps the last dot lit
    // forever after the CLI exits.
    if (this.paneSession.has(paneId) || this.lastStatus.has(paneId)) {
      this.pushStatus(paneId, 'idle', null, Date.now())
    }
    const projectPath = this.paneProject.get(paneId)
    const session = this.paneSession.get(paneId)
    if (session) {
      this.paneSession.delete(paneId)
      this.sessionPane.delete(session)
      this.sessionActivity.delete(session)
      // Drop the dead session's parse state before leaveProject decides
      // whether the watch is still needed. Located by folder so it is found
      // whether the watch came from the pane's cwd or from a hook.
      const watch = this.findWatchByDir(dirname(session))
      watch?.files.delete(session)
      watch?.stats.delete(session)
    }
    if (projectPath !== undefined) {
      this.paneProject.delete(paneId)
      this.leaveProject(paneId, projectPath)
    }
    // leaveProject only reaches watches keyed by root + project. A watch a hook
    // opened is keyed by its folder, so the pane would stay in its `panes` set
    // for ever, holding an fs.watch and a poll timer for a pane that is gone.
    this.leaveEveryWatch(paneId)
    this.hookPanes.delete(paneId) // the pane is gone, not merely between sessions
    this.lastInput.delete(paneId)
    this.lastPushed.delete(paneId)
    this.lastStatus.delete(paneId) // must stay after pushStatus
  }

  /**
   * The shell reached a prompt (OSC 9;9 fires on every prompt render), so
   * claude is provably not running in this pane — covers `/exit`, where the
   * pty never dies and the dot would otherwise stay amber forever.
   */
  notePrompt(paneId: string): void {
    const session = this.paneSession.get(paneId)
    if (!session) return
    // A stray OSC mid-stream (claude printing, a nested shell) must not tear
    // down a live conversation.
    if (Date.now() - (this.sessionActivity.get(session) ?? 0) < SESSION_ACTIVE_MS) return
    this.paneApproval.delete(paneId)
    this.endSession(paneId)
  }

  /** A fresh spawn must not be deduped against the previous session's pushes. */
  resetPane(paneId: string): void {
    this.lastPushed.delete(paneId)
    this.lastStatus.delete(paneId)
    this.paneApproval.delete(paneId)
    this.paneTurn.delete(paneId)
  }

  unwatchAll(): void {
    for (const watch of this.projects.values()) this.disposeWatch(watch)
    this.projects.clear()
    this.paneProject.clear()
    this.paneSession.clear()
    this.sessionPane.clear()
    this.sessionActivity.clear()
    this.lastInput.clear()
    this.lastPushed.clear()
    this.lastStatus.clear()
    this.paneApproval.clear()
    this.hookPanes.clear()
    this.paneTurn.clear()
  }

  private leaveProject(paneId: string, projectPath: string): void {
    for (const root of this.roots) {
      const key = watchKey(root, projectPath)
      const watch = this.projects.get(key)
      if (!watch) continue
      watch.panes.delete(paneId)
      // Keep the watch alive while a pane still has a session assigned there
      // (e.g. the user cd'ed away while claude keeps running).
      const stillNeeded =
        watch.panes.size > 0 ||
        [...watch.files.keys()].some((f) => this.sessionPane.has(f))
      if (!stillNeeded) {
        this.disposeWatch(watch)
        this.projects.delete(key)
      }
    }
  }

  /**
   * Drop a dead pane from every watch, whatever it is keyed by, and dispose the
   * ones nothing needs any more. Same "still needed" rule as leaveProject: a
   * watch holding a live session outlives the pane list.
   */
  private leaveEveryWatch(paneId: string): void {
    for (const [key, watch] of [...this.projects]) {
      if (!watch.panes.delete(paneId)) continue
      const stillNeeded =
        watch.panes.size > 0 || [...watch.files.keys()].some((f) => this.sessionPane.has(f))
      if (!stillNeeded) {
        this.disposeWatch(watch)
        this.projects.delete(key)
      }
    }
  }

  /**
   * `dir` is normally derived from root + project, and passed explicitly only
   * when a hook named a transcript outside every known config root.
   */
  private createWatch(root: string, projectPath: string, dir?: string): ProjectWatch {
    const watch: ProjectWatch = {
      projectPath,
      root,
      dir: dir ?? transcriptDir(root, projectPath),
      panes: new Set(),
      watcher: null,
      // fs.watch can die silently (dir deleted/recreated) or the dir may not
      // exist yet; a slow poll re-attaches and catches missed events.
      pollTimer: setInterval(() => {
        if (!watch.watcher) this.attach(watch)
        this.schedule(watch)
      }, POLL_MS),
      debounce: null,
      refreshing: false,
      dirty: false,
      stats: new Map(),
      files: new Map(),
      primed: false
    }
    this.attach(watch)
    return watch
  }

  private disposeWatch(watch: ProjectWatch): void {
    watch.watcher?.close()
    watch.watcher = null
    clearInterval(watch.pollTimer)
    if (watch.debounce) clearTimeout(watch.debounce)
    watch.debounce = null
  }

  private attach(pw: ProjectWatch): void {
    try {
      // Any event just schedules a rescan; the scan diffs mtimes itself.
      const watcher = watch(pw.dir, { persistent: false }, () => this.schedule(pw))
      watcher.on('error', () => {
        watcher.close()
        pw.watcher = null // poll re-attaches
      })
      pw.watcher = watcher
    } catch {
      pw.watcher = null // dir doesn't exist yet — poll retries
    }
  }

  /** Trailing debounce: coalesces append bursts during streaming. */
  private schedule(watch: ProjectWatch): void {
    if (watch.debounce) return
    watch.debounce = setTimeout(() => {
      watch.debounce = null
      void this.refresh(watch)
    }, DEBOUNCE_MS)
  }

  private async refresh(watch: ProjectWatch): Promise<void> {
    if (watch.refreshing) {
      watch.dirty = true
      return
    }
    watch.refreshing = true
    try {
      do {
        watch.dirty = false
        await this.scan(watch)
      } while (watch.dirty)
    } finally {
      watch.refreshing = false
    }
  }

  private async scan(watch: ProjectWatch): Promise<void> {
    let names: string[]
    try {
      names = (await readdir(watch.dir, { withFileTypes: true }))
        .filter((d) => d.isFile() && d.name.endsWith('.jsonl'))
        .map((d) => d.name)
    } catch {
      return // dir missing — poll keeps checking
    }
    const primed = watch.primed
    watch.primed = true
    for (const name of names) {
      const file = join(watch.dir, name)
      let st: Stats
      try {
        st = await stat(file)
      } catch {
        continue // deleted mid-scan
      }
      const prev = watch.stats.get(file)
      watch.stats.set(file, { mtime: st.mtimeMs, size: st.size })

      // For a session we're already tailing, `offset` answers "have we read
      // this?" exactly, with no clock involved. mtime only bootstraps files we
      // have never claimed — its 1ms granularity misses ~90% of appends, since
      // a stat→append→stat inside one millisecond looks unchanged.
      const assigned = watch.files.get(file)
      const changed = assigned
        ? st.size !== assigned.offset // covers growth and truncation alike
        : !prev || prev.mtime !== st.mtimeMs || prev.size !== st.size
      if (!changed) continue
      // The first pass only inventories sessions nobody has claimed — it is what
      // stops a folder's existing transcripts from grabbing a badge the moment
      // it starts being watched. A session a hook named is already claimed, so
      // it is exempt: we were told whose it is rather than having to guess.
      if (!primed && !this.sessionPane.has(file)) continue

      let paneId = this.sessionPane.get(file)
      if (paneId === undefined) {
        paneId = this.pickPane(watch, prev === undefined)
        if (paneId === undefined) continue // outside activity — ignore
        // The pane starts (or resumes) a session: it replaces any previous one.
        const prevSession = this.paneSession.get(paneId)
        if (prevSession) this.sessionPane.delete(prevSession)
        this.paneSession.set(paneId, file)
        this.sessionPane.set(file, paneId)
        watch.files.set(file, emptyFileState())
      }
      const state = watch.files.get(file) ?? emptyFileState()
      watch.files.set(file, state)
      const read = await this.tail(file, st.size, state)
      // Only a real read counts as activity: a transient EBUSY leaves
      // size !== offset true forever, which would otherwise refresh
      // lastActivity on every scan and hold pickPane's guard open.
      if (read <= 0) continue
      const now = Date.now()
      this.sessionActivity.set(file, now)
      this.push(paneId, file, state)
      // A pending permission prompt outranks anything the transcript can say:
      // it *is* the state the transcript cannot see. It holds until the guarded
      // tool produces a result — which is what proves the prompt was answered —
      // or until a hook reports the turn moved on.
      const open = this.paneApproval.get(paneId)
      if (open && approvalResolved(open, state)) this.paneApproval.delete(paneId)
      const pending = this.paneApproval.get(paneId)
      const status = statusFor(pending, this.paneTurn.get(paneId), state)
      const tool = status === 'waiting-approval' ? pending?.toolName ?? state.lastTool : state.lastTool
      this.pushStatus(paneId, status, tool, now)
    }
  }

  /**
   * Last resort for a session nobody claimed: the pane in this project with the
   * most recent keystrokes. Only panes that cannot announce themselves are
   * eligible — see hookPanes. Guessing was never good; it is simply all there
   * was before Claude Code could be asked.
   */
  private pickPane(watch: ProjectWatch, isNewFile: boolean): string | undefined {
    const now = Date.now()
    const window = isNewFile ? ASSIGN_WINDOW_MS : RESUME_WINDOW_MS
    let best: string | undefined
    let bestTs = -1
    for (const paneId of watch.panes) {
      // This pane's sessions arrive by name. An unannounced one is not its own.
      if (this.hookPanes.has(paneId)) continue
      const ts = this.lastInput.get(paneId) ?? -1
      if (ts <= bestTs || now - ts > window) continue
      const session = this.paneSession.get(paneId)
      if (session && now - (this.sessionActivity.get(session) ?? 0) < SESSION_ACTIVE_MS) continue
      bestTs = ts
      best = paneId
    }
    return best
  }

  /**
   * Incremental tail: read only appended bytes, keep a partial-line remainder.
   * Returns bytes consumed; 0 means nothing was read (up to date, or a
   * transient error the caller must not mistake for activity).
   */
  private async tail(file: string, size: number, state: FileState): Promise<number> {
    let read = 0
    try {
      if (size < state.offset) Object.assign(state, emptyFileState()) // truncated
      if (size === state.offset) return 0
      const fh = await open(file, 'r')
      try {
        const buf = Buffer.alloc(READ_CHUNK)
        while (state.offset < size) {
          const { bytesRead } = await fh.read(buf, 0, READ_CHUNK, state.offset)
          if (bytesRead <= 0) break
          state.offset += bytesRead
          read += bytesRead
          // StringDecoder holds back multi-byte chars split across chunks.
          const text = state.remainder + state.decoder.write(buf.subarray(0, bytesRead))
          const lines = text.split('\n')
          state.remainder = lines.pop() ?? ''
          for (const line of lines) ingest(state, line)
        }
      } finally {
        await fh.close()
      }
    } catch {
      // transient EBUSY/EPERM/ENOENT — retry on the next event/poll tick
    }
    return read
  }


  private push(paneId: string, file: string, state: FileState): void {
    const update: UsageUpdate = {
      paneId,
      sessionId: basename(file, '.jsonl'),
      model: state.model,
      totals: { ...state.totals },
      contextTokens: state.contextTokens
    }
    const key = JSON.stringify(update)
    if (key === this.lastPushed.get(paneId)) return
    this.lastPushed.set(paneId, key)
    if (this.target && !this.target.isDestroyed()) {
      this.target.send(IPC.UsageUpdate, update)
    }
  }


  private pushStatus(
    paneId: string,
    status: PaneStatus,
    lastTool: string | null,
    lastActivity: number
  ): void {
    const update: StatusUpdate = { paneId, status, lastTool, lastActivity }
    const key = `${status}|${lastTool ?? ''}`
    if (key === this.lastStatus.get(paneId)) return
    this.lastStatus.set(paneId, key)
    if (this.target && !this.target.isDestroyed()) {
      this.target.send(IPC.UsageStatus, update)
    }
  }
}

/**
 * A pure function of parsed state — no clock, no tick. Status is pushed from
 * scan() the moment a line lands, so latency is fs.watch + the debounce.
 */
export function deriveStatus(state: FileState): PaneStatus {
  if (state.phase === 'active') return 'working'
  if (state.phase === 'ended') return 'waiting-input'
  return 'idle'
}

/**
 * Fold one transcript line into a session's state. Pure: this and deriveStatus
 * are the whole correctness story for the dot, so they stay free of `this` and
 * testable in isolation (see usageWatcher.test.ts).
 */
export function ingest(state: FileState, line: string): void {
  // Cheap gate: only assistant (usage + status) and user (tool_result /
  // new-prompt) lines carry signal — skip the bulky metadata line types
  // (file-history-snapshot, mode, attachment, …) without parsing them.
  const isAssistant = line.includes('"type":"assistant"')
  const isUser = !isAssistant && line.includes('"type":"user"')
  if (!isAssistant && !isUser) return
  let obj: {
    type?: string
    uuid?: string
    requestId?: string
    isSidechain?: boolean
    isMeta?: boolean
    message?: {
      id?: string
      model?: string
      stop_reason?: string
      content?: string | { type?: string; name?: string; tool_use_id?: string }[]
      usage?: {
        input_tokens?: number
        output_tokens?: number
        cache_read_input_tokens?: number
        cache_creation_input_tokens?: number
      }
    }
  }
  try {
    obj = JSON.parse(line)
  } catch {
    return // partial/corrupt line
  }

  // A user line either feeds a tool_result straight back to the model or
  // opens a new human turn — either way the turn is running. Sidechain
  // (subagent) lines don't move the main-thread status, and isMeta lines are
  // bookkeeping that lands *after* a turn completes: treating those as a
  // prompt would pin the dot to `working` forever.
  if (obj?.type === 'user') {
    if (obj.isSidechain === true || obj.isMeta === true) return
    state.phase = 'active'
    // A tool_result is proof its tool was answered for — approved or denied,
    // either way it ran or was refused, and either way the permission prompt
    // guarding it is gone. Counting them is how the red dot is retired.
    const content = obj.message?.content
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block?.type === 'tool_result') state.toolResults++
      }
    }
    return
  }

  if (obj?.type !== 'assistant') return

  // Status signal from the main-thread assistant message.
  if (obj.isSidechain !== true) {
    const stop = obj.message?.stop_reason
    // Deliberately no `waiting-approval`: a permission prompt and a 10-minute
    // build are byte-identical here (tool_use, then silence). The transcript
    // cannot tell them apart, and guessing produced a red dot that was wrong
    // 19% of wall-clock. Claude Code's Notification hook is the honest source.
    if (stop === 'tool_use') state.phase = 'active'
    else if (stop === 'end_turn' || stop === 'stop_sequence' || stop === 'max_tokens') {
      state.phase = 'ended'
    }
    const content = obj.message?.content
    if (Array.isArray(content)) {
      for (let i = content.length - 1; i >= 0; i--) {
        if (content[i]?.type === 'tool_use' && content[i]?.name) {
          state.lastTool = content[i].name ?? null
          break
        }
      }
    }
  }

  const usage = obj.message?.usage
  if (!usage) return
  const t: UsageTotals = {
    input: usage.input_tokens ?? 0,
    output: usage.output_tokens ?? 0,
    cacheRead: usage.cache_read_input_tokens ?? 0,
    cacheCreate: usage.cache_creation_input_tokens ?? 0
  }
  // Last occurrence of a message wins: subtract the old snapshot, add the new.
  // Keying on message.id (never absent in practice) rather than the per-line
  // uuid, since streaming splits one message across lines sharing that id.
  // With no identity at all, count once — keying every such line to the same
  // fallback would make each one cancel the last.
  const msgId = obj.message?.id
  const key = msgId ? `${obj.requestId ?? ''}|${msgId}` : obj.uuid ? `u:${obj.uuid}` : null
  if (key !== null) {
    const prev = state.seen.get(key)
    if (prev) {
      state.totals.input -= prev.input
      state.totals.output -= prev.output
      state.totals.cacheRead -= prev.cacheRead
      state.totals.cacheCreate -= prev.cacheCreate
    }
    state.seen.set(key, t)
  }
  state.totals.input += t.input
  state.totals.output += t.output
  state.totals.cacheRead += t.cacheRead
  state.totals.cacheCreate += t.cacheCreate

  // Context fill tracks the main thread only; synthetic error lines carry
  // model "<synthetic>" and zero usage.
  const context = t.input + t.cacheRead + t.cacheCreate
  const model = obj.message?.model
  if (!obj.isSidechain && model !== '<synthetic>' && context > 0) {
    state.contextTokens = context
    if (typeof model === 'string') state.model = model
  }
}
