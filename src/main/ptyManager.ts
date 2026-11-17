import { ipcMain } from 'electron'
import type { WebContents } from 'electron'
import * as pty from 'node-pty'
import { existsSync } from 'fs'
import { homedir } from 'os'
import { AGENTS } from '../shared/agents'
import { IPC } from '../shared/ipc'
import type { SpawnOptions, SpawnResult, StatusUpdate } from '../shared/ipc'
import type { LcServer } from './lcServer'
import { QuietWatcher } from './quietStatus'
import { detectShell, hookEnv, lcEnv } from './shell'
import { loadShortcuts, psStartupShortcuts } from './shortcuts'
import type { UsageWatcher } from './usageWatcher'

/**
 * Windows: append the saved shortcuts to the pane's `-Command` startup, so
 * they work even where the execution policy keeps $PROFILE from loading (see
 * psStartupShortcuts). Anything unexpected leaves the args exactly as they were.
 */
function withShortcuts(args: string[]): string[] {
  if (process.platform !== 'win32') return args
  const i = args.indexOf('-Command')
  if (i < 0 || i !== args.length - 2) return args
  let extra = ''
  try {
    extra = psStartupShortcuts(loadShortcuts())
  } catch {
    return args
  }
  // Windows caps a command line at 32K chars; stay far below it.
  if (!extra || args[i + 1]!.length + extra.length > 24_000) return args
  return [...args.slice(0, -1), `${args[i + 1]}; ${extra}`]
}

/** Set per pane from SpawnOptions.crew/agent; never inherited from outside. */
const CREW_ENV = ['LIGHTCODE_CREW', 'LIGHTCODE_HANDLE', 'LIGHTCODE_LEAD', 'LIGHTCODE_AGENT']

/** OSC 9;9;<cwd> BEL|ST — emitted by the prompt hook injected in shell.ts. */
const CWD_OSC = /\x1b\]9;9;("?)([^\x07\x1b]*)\1(?:\x07|\x1b\\)/g

export class PtyManager {
  private ptys = new Map<string, pty.IPty>()
  private carries = new Map<string, string>() // partial OSC split across chunks
  private target: WebContents | null = null

  /** Where the agent CLI listens, so the claude wrapper can check it is on. */
  private lcSocket: string | null = null
  /** Issues each pty the token that proves to `lc` which pane is asking. */
  private lcTokens: Pick<LcServer, 'issueToken' | 'revokeToken'> | null = null

  /**
   * The ≈ status of panes opened for an agent with no hooks (see quietStatus).
   * Nothing is fed to it for any other pane, so a plain shell or a Claude pane
   * costs one map lookup per chunk.
   */
  private quiet = new QuietWatcher((paneId, status, at) => {
    const update: StatusUpdate = { paneId, status, lastTool: null, lastActivity: at, source: 'heuristic' }
    this.send(IPC.UsageStatus, update)
  })

  constructor(private usage: UsageWatcher) {}

  setLcSocket(path: string | null): void {
    this.lcSocket = path
  }

  setLcTokens(tokens: Pick<LcServer, 'issueToken' | 'revokeToken'>): void {
    this.lcTokens = tokens
  }

  setTarget(wc: WebContents): void {
    this.target = wc
  }

  register(): void {
    ipcMain.handle(IPC.PtySpawn, (_e, opts: SpawnOptions): SpawnResult => this.spawn(opts))
    // Hot paths use fire-and-forget channels to avoid promise round-trips.
    ipcMain.on(IPC.PtyWrite, (_e, paneId: string, data: string) => {
      this.usage.noteInput(paneId) // feeds session→pane attribution
      this.quiet.input(paneId, data)
      this.ptys.get(paneId)?.write(data)
    })
    ipcMain.on(IPC.PtyResize, (_e, paneId: string, cols: number, rows: number) => {
      try {
        this.ptys.get(paneId)?.resize(Math.max(2, cols), Math.max(1, rows))
      } catch {
        // resize can throw if the process is mid-exit
      }
    })
    ipcMain.on(IPC.PtyKill, (_e, paneId: string) => this.kill(paneId))
    ipcMain.on(IPC.PtyAgent, (_e, paneId: string, agent: unknown) => {
      if (this.ptys.has(paneId)) this.watchAgent(paneId, typeof agent === 'string' ? agent : undefined)
    })
    ipcMain.handle(IPC.PtyClaudeActive, (_e, paneId: string): boolean =>
      this.usage.hasSession(paneId)
    )
  }

  spawn({ paneId, cwd, cols, rows, role, crew, agent }: SpawnOptions): SpawnResult {
    this.kill(paneId)
    const shell = detectShell()

    let realCwd = cwd
    let cwdFallback = false
    if (!cwd || !existsSync(cwd)) {
      realCwd = homedir()
      cwdFallback = true
    }

    // Only where `lc` can be reached at all; a pane with no socket has nothing
    // to prove its identity to.
    const lcToken = this.lcSocket !== null ? this.lcTokens?.issueToken(paneId) : undefined

    // A Light Code started from inside a Light Code pane (`npm run dev`, say)
    // inherits that pane's token and socket. Left in place they would reach the
    // outer app and pass as the outer pane, so only what this instance issues
    // may stand.
    const inherited = { ...(process.env as Record<string, string>) }
    delete inherited.LIGHTCODE_LC_TOKEN
    delete inherited.LIGHTCODE_LC_SOCKET
    // Likewise who the outer pane was: an inner pane in no crew must not say
    // it leads the outer one's.
    for (const key of CREW_ENV) delete inherited[key]

    const proc = pty.spawn(shell.file, withShortcuts(shell.args), {
      name: 'xterm-256color',
      cwd: realCwd,
      cols: Math.max(2, cols),
      rows: Math.max(1, rows),
      ...(process.platform === 'win32' ? { useConpty: true } : {}),
      env: {
        ...inherited,
        ...shell.env,
        ...hookEnv(),
        ...lcEnv(this.lcSocket),
        // Read by the agent-hook reporter, which stamps it onto every event it
        // forwards. This is what makes session→pane attribution a fact rather
        // than a guess from keystroke timing.
        LIGHTCODE_PANE: paneId,
        // Who this pane is, in a form `lc` cannot be talked out of. The pane id
        // above is public — it is printed by `lc ls` — so anything could claim
        // it; this is known only to this pty and its children. See
        // LcServer.resolveCaller.
        ...(lcToken ? { LIGHTCODE_LC_TOKEN: lcToken } : {}),
        // The squad role, read by the generated `claude` wrapper at every
        // launch. See SpawnOptions.role on why it lives here and not on the
        // first command line.
        ...(role
          ? {
              LIGHTCODE_ROLE: role.id,
              LIGHTCODE_ROLE_PROMPT: role.prompt,
              LIGHTCODE_SQUAD_DIR: role.squadDir
            }
          : {}),
        // The orchestra this pane plays in, and which agent it was opened for.
        // Only when there is one: a plain pane's environment is what it was.
        ...(crew
          ? {
              LIGHTCODE_CREW: crew.id,
              LIGHTCODE_HANDLE: crew.handle,
              ...(crew.lead ? { LIGHTCODE_LEAD: '1' } : {})
            }
          : {}),
        ...(agent ? { LIGHTCODE_AGENT: agent } : {})
      }
    })
    this.ptys.set(paneId, proc)
    this.watchAgent(paneId, agent)
    this.usage.resetPane(paneId) // don't dedupe a fresh session against the old one
    this.usage.bindPane(paneId, realCwd)

    proc.onData((data) => {
      this.send(IPC.PtyData, paneId, data)
      const atPrompt = this.trackCwd(paneId, data)
      if (this.quiet.watching(paneId)) {
        // Claude started by hand in this pane speaks for itself, exactly.
        if (atPrompt) this.quiet.prompt(paneId)
        else if (!this.usage.hasSession(paneId)) this.quiet.output(paneId, data)
      }
    })
    proc.onExit(({ exitCode }) => {
      // Only forward exits for panes we still own (not explicit kills).
      if (this.ptys.get(paneId) === proc) {
        this.ptys.delete(paneId)
        this.carries.delete(paneId)
        this.quiet.forget(paneId)
        this.usage.unbindPane(paneId)
        this.lcTokens?.revokeToken(paneId)
        this.send(IPC.PtyExit, paneId, exitCode)
      }
    })

    return { shell: shell.file, cwd: realCwd, cwdFallback }
  }

  /**
   * Guess at this pane's status from its output when it was opened for an
   * agent that reports nothing itself; stop guessing for any other.
   */
  private watchAgent(paneId: string, agent: string | undefined): void {
    if (agent !== undefined && AGENTS[agent]?.status === 'heuristic') this.quiet.watch(paneId)
    else this.quiet.forget(paneId)
  }

  /**
   * Follow the pane's live cwd from the OSC 9;9 the prompt hook emits. True
   * when this chunk drew a shell prompt.
   */
  private trackCwd(paneId: string, data: string): boolean {
    const text = (this.carries.get(paneId) ?? '') + data
    let cwd: string | null = null
    let lastEnd = 0
    CWD_OSC.lastIndex = 0
    for (let m = CWD_OSC.exec(text); m; m = CWD_OSC.exec(text)) {
      cwd = m[2]
      lastEnd = CWD_OSC.lastIndex
    }
    if (cwd) {
      // The hook fires on every prompt render, so reaching here means the
      // shell is back at a prompt — claude has exited, whatever the cwd says.
      this.usage.notePrompt(paneId)
      this.usage.bindPane(paneId, cwd)
      this.send(IPC.PtyCwd, paneId, cwd) // renderer persists it for respawn
    }
    // Keep a short tail in case a sequence is split across data chunks.
    this.carries.set(paneId, text.slice(Math.max(lastEnd, text.length - 256)))
    return cwd !== null
  }

  kill(paneId: string): void {
    const proc = this.ptys.get(paneId)
    if (!proc) return
    this.ptys.delete(paneId)
    this.carries.delete(paneId)
    this.quiet.forget(paneId)
    this.usage.unbindPane(paneId)
    this.lcTokens?.revokeToken(paneId)
    try {
      proc.kill()
    } catch {
      // already dead
    }
  }

  killAll(): void {
    for (const id of [...this.ptys.keys()]) this.kill(id)
  }

  private send(channel: string, ...args: unknown[]): void {
    if (this.target && !this.target.isDestroyed()) {
      this.target.send(channel, ...args)
    }
  }
}
