import { app } from 'electron'
import { chmodSync, mkdirSync, readdirSync, rmSync, watch } from 'fs'
import type { FSWatcher } from 'fs'
import { readdir, readFile, stat, unlink } from 'fs/promises'
import { join } from 'path'
import { atomicWrite, isPidAlive, ownerPid } from './instance'

/**
 * Claude Code lifecycle events, straight from the CLI rather than inferred.
 *
 * Why this exists at all: the transcript is an honest record of what *happened*,
 * but a permission prompt leaves no trace in it. A tool_use line followed by
 * silence is byte-identical whether Claude is waiting for a human to press "y"
 * or running a ten-minute build (see the note on PaneStatus in shared/ipc.ts).
 * Hooks are the only source that can tell those apart, so they are used for
 * exactly two things the transcript cannot do:
 *
 *   1. bind a session to the pane that started it, by name rather than by
 *      guessing from keystroke timing, and
 *   2. report a pending permission prompt.
 *
 * Everything else — token totals, context fill, turn phase — still comes from
 * the transcript, which remains the base signal. A pane with no hooks at all
 * (fish, nu, a Claude Code too old to send them) behaves exactly as before.
 *
 * How the config reaches Claude Code: it does NOT. Nothing here writes to the
 * user's ~/.claude/settings.json. The app generates its own settings file under
 * userData and the shell integration launches `claude --settings <that file>`,
 * which Claude Code merges on top of the user's own settings ("load additional
 * settings from"). So the hooks exist only inside Light Code's panes, a plain
 * terminal elsewhere is untouched, and there is nothing to uninstall.
 */

/**
 * The events we ask for — deliberately one hook run per TURN, never per tool
 * call. PreToolUse/PostToolUse would spawn a process for every Edit and Bash,
 * which on Windows means a PowerShell launch each time; the transcript already
 * reports tool activity perfectly well.
 */
export const HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PermissionRequest',
  'Notification',
  'Stop',
  'SessionEnd'
] as const

export type HookEventName = (typeof HOOK_EVENTS)[number]

const EVENT_SET: ReadonlySet<string> = new Set<string>(HOOK_EVENTS)

/** Generous: the script writes one small file. Never blocks Claude anyway. */
const HOOK_TIMEOUT_S = 10
/** Coalesce the burst of fs events a single write produces. */
const DRAIN_DEBOUNCE_MS = 40
/** fs.watch dies silently when a directory is replaced; a slow poll re-arms. */
const POLL_MS = 4000
/** A pane id we generated: `p_<base36>`. Anything else is not ours. */
const PANE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/

/** One parsed hook delivery. All fields beyond pane/event may be absent. */
export interface HookEvent {
  paneId: string
  event: HookEventName
  sessionId: string | null
  cwd: string | null
  transcriptPath: string | null
  toolName: string | null
  toolUseId: string | null
  message: string | null
  /** Set on subagent events — those must not move the main-thread status. */
  agentId: string | null
}

interface Envelope {
  pane?: unknown
  hook?: {
    hook_event_name?: unknown
    session_id?: unknown
    cwd?: unknown
    transcript_path?: unknown
    tool_name?: unknown
    tool_use_id?: unknown
    message?: unknown
    agent_id?: unknown
  }
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null
}

/**
 * Parse one spooled envelope. Pure, and hostile-input safe: the file is written
 * by a shell script that interpolates an environment variable, so a malformed
 * or truncated envelope has to be survivable rather than thrown.
 */
export function parseEnvelope(text: string): HookEvent | null {
  let env: Envelope
  try {
    env = JSON.parse(text) as Envelope
  } catch {
    return null
  }
  const paneId = str(env?.pane)
  const event = str(env?.hook?.hook_event_name)
  if (!paneId || !PANE_ID_RE.test(paneId)) return null
  if (!event || !EVENT_SET.has(event)) return null
  const h = env.hook ?? {}
  return {
    paneId,
    event: event as HookEventName,
    sessionId: str(h.session_id),
    cwd: str(h.cwd),
    transcriptPath: str(h.transcript_path),
    toolName: str(h.tool_name),
    toolUseId: str(h.tool_use_id),
    message: str(h.message),
    agentId: str(h.agent_id)
  }
}

/**
 * Whether a Notification is Claude asking for permission, as opposed to the
 * other thing Claude Code notifies about — that a session has been idle for a
 * while. Mapping an idle notification to "needs approval" would light the red
 * dot for a session nobody is blocking on, so an unrecognised message is
 * deliberately ignored rather than guessed at.
 */
export function isPermissionNotification(message: string | null): boolean {
  if (!message) return false
  return /\bpermission\b|\bapprove\b|\ballow\b|\bwants to\b|\bneeds your\b/i.test(message)
}

/**
 * The status a hook event implies, or null when it carries none.
 *
 * `SessionStart` deliberately sets nothing: a freshly opened Claude is idle at
 * its prompt, and reporting `waiting-input` there would arm the babysitter on
 * a session the user has not even typed into yet.
 */
export function statusForEvent(ev: HookEvent): 'working' | 'waiting-input' | 'waiting-approval' | null {
  if (ev.agentId) return null // subagent traffic never moves the main thread
  switch (ev.event) {
    case 'UserPromptSubmit':
      return 'working'
    case 'PermissionRequest':
      return 'waiting-approval'
    case 'Notification':
      return isPermissionNotification(ev.message) ? 'waiting-approval' : null
    case 'Stop':
      return 'waiting-input'
    default:
      return null
  }
}

// ---------- Asset generation ----------

export interface HookPaths {
  dir: string
  spool: string
  settings: string
  script: string
}

/** The folder holding every instance's hook assets, one subfolder per pid. */
export function hookRoot(): string {
  return join(app.getPath('userData'), 'agent-hooks')
}

/**
 * This instance's hook assets, under its own pid.
 *
 * The pid is not decoration, and its absence was a real bug. Every running Light
 * Code used to share one spool: `HookWatcher.start` purges the spool on the
 * belief that anything in it predates this launch, so a second window starting
 * deleted the first one's in-flight envelopes; and `pass()` unlinks each file
 * before dispatching it, so whichever instance's timer fired first ate an event
 * meant for the other, which then dropped it silently for a pane it had never
 * heard of.
 *
 * Both losses are invisible and neither degrades gracefully. `waiting-approval`
 * exists only because of hooks, so the red "needs approval" dot goes dark; and
 * the babysitter arms only on `waiting-input`, so a lost `Stop` stalls an
 * autonomous run for good. The `lc` socket already keyed itself by pid for
 * exactly this reason — this is the same fix applied to the other door.
 *
 * Keying the whole directory rather than only the spool also settles a second
 * hazard: `settings.json` and the reporter script are rewritten on every launch
 * and handed to `claude --settings` by path, so two instances could truncate one
 * while the other's agent was starting.
 */
export function hookPaths(): HookPaths {
  const dir = join(hookRoot(), String(process.pid))
  return {
    dir,
    spool: join(dir, 'spool'),
    settings: join(dir, 'settings.json'),
    script: join(dir, process.platform === 'win32' ? 'report.ps1' : 'report.sh')
  }
}

/**
 * Hook folders left by runs that were killed rather than closed.
 *
 * Same rule as the socket sweep it mirrors: only a pid that is provably gone.
 * A pid that still answers may be a Light Code somebody is using, and deleting
 * its spool mid-turn is precisely the accident the pid exists to prevent.
 */
export function sweepDeadHookDirs(root = hookRoot()): void {
  let names: string[]
  try {
    names = readdirSync(root)
  } catch {
    return
  }
  for (const name of names) {
    const pid = ownerPid(name)
    if (pid === null || pid === process.pid || isPidAlive(pid)) continue
    try {
      rmSync(join(root, name), { recursive: true, force: true })
    } catch {
      // another instance swept it first
    }
  }
}

/**
 * The reporter, in POSIX sh so /bin/sh on any platform can run it.
 *
 * Two properties matter more than brevity here. It exits 0 on every path —
 * any other code makes Claude Code print "<hook> hook error" into the user's
 * transcript. And it is a silent no-op without a pane id, so the same file is
 * harmless if it is ever reached from a terminal Light Code did not spawn.
 */
export function posixScript(): string {
  return [
    '#!/bin/sh',
    '# Generated by Light Code. Reports Claude Code lifecycle events to the app.',
    '# No pane id in the environment means this is not a Light Code pane: do nothing.',
    '[ -n "$LIGHTCODE_PANE" ] || exit 0',
    '[ -n "$LIGHTCODE_HOOK_DIR" ] || exit 0',
    '[ -d "$LIGHTCODE_HOOK_DIR" ] || exit 0',
    'tmp="$LIGHTCODE_HOOK_DIR/$(date -u +%Y%m%d%H%M%S)-$$"',
    '# Written without an extension, then renamed: the app reads *.json only, so a',
    '# same-directory rename (atomic) means it can never see a partial envelope.',
    '{',
    '  printf \'{"pane":"%s","hook":\' "$LIGHTCODE_PANE"',
    '  cat',
    "  printf '}'",
    '} > "$tmp" 2>/dev/null || exit 0',
    'mv "$tmp" "$tmp.json" 2>/dev/null || rm -f "$tmp" 2>/dev/null',
    'exit 0',
    ''
  ].join('\n')
}

/** The same reporter for Windows, where sh is not a given. */
export function windowsScript(): string {
  return [
    '# Generated by Light Code. Reports Claude Code lifecycle events to the app.',
    '$ErrorActionPreference = "SilentlyContinue"',
    'if (-not $env:LIGHTCODE_PANE) { exit 0 }',
    'if (-not $env:LIGHTCODE_HOOK_DIR) { exit 0 }',
    'if (-not (Test-Path -LiteralPath $env:LIGHTCODE_HOOK_DIR)) { exit 0 }',
    'try {',
    '  $raw = [Console]::In.ReadToEnd()',
    '  if (-not $raw) { exit 0 }',
    '  $name = (Get-Date).ToUniversalTime().ToString("yyyyMMddHHmmss") + "-" + $PID',
    '  $tmp = Join-Path $env:LIGHTCODE_HOOK_DIR $name',
    '  $body = \'{"pane":"\' + $env:LIGHTCODE_PANE + \'","hook":\' + $raw + \'}\'',
    '  [System.IO.File]::WriteAllText($tmp, $body)',
    '  Move-Item -LiteralPath $tmp -Destination ($tmp + ".json") -Force',
    '} catch { }',
    'exit 0',
    ''
  ].join('\n')
}

/**
 * The settings file handed to `claude --settings`. Exec form (an explicit args
 * array) rather than a shell string, so nothing here is ever re-tokenised by a
 * shell — userData paths contain spaces on macOS. `async` keeps Claude from
 * waiting on us: the reporter is fire-and-forget by definition, and a hook that
 * blocked every turn boundary would be felt on Windows, where each run is a
 * PowerShell start-up.
 */
export function renderHookSettings(command: string, args: string[]): object {
  const handler = {
    type: 'command',
    command,
    args,
    timeout: HOOK_TIMEOUT_S,
    async: true
  }
  const hooks: Record<string, unknown> = {}
  for (const event of HOOK_EVENTS) hooks[event] = [{ hooks: [{ ...handler }] }]
  return { hooks }
}

/** How Claude Code should invoke the reporter on this platform. */
export function reporterCommand(script: string): { command: string; args: string[] } {
  if (process.platform === 'win32') {
    return {
      command: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script]
    }
  }
  // Invoked through sh rather than relying on the execute bit surviving a
  // packaged install or a noexec mount.
  return { command: '/bin/sh', args: [script] }
}

/**
 * Write the reporter and its settings file. Returns the paths, or null when the
 * assets could not be created — the caller then simply runs without hooks and
 * the transcript remains the only signal, exactly as it was before.
 */
export function installHookAssets(): HookPaths | null {
  const paths = hookPaths()
  try {
    mkdirSync(paths.spool, { recursive: true })
    const script = process.platform === 'win32' ? windowsScript() : posixScript()
    // Atomic even though the directory is now ours alone: a crash mid-write
    // would otherwise leave a truncated reporter that every later launch keeps,
    // and `claude --settings` reads these by path at every agent start.
    if (!atomicWrite(paths.script, script)) return null
    if (process.platform !== 'win32') {
      try {
        chmodSync(paths.script, 0o755)
      } catch {
        // /bin/sh is given the path explicitly, so the bit is a nicety
      }
    }
    const { command, args } = reporterCommand(paths.script)
    const settings = JSON.stringify(renderHookSettings(command, args), null, 2)
    if (!atomicWrite(paths.settings, settings)) return null
    return paths
  } catch {
    return null
  }
}

// ---------- Spool watcher ----------

/**
 * Drains the spool directory and reports events in the order they were written.
 *
 * Ordering is by mtime rather than by filename: the reporter's name carries a
 * one-second timestamp, which is not fine enough to separate two events in the
 * same second, and applying `Stop` before the `PermissionRequest` that preceded
 * it would leave the red dot lit after the prompt had been answered.
 */
export class HookWatcher {
  private spool: string | null = null
  private watcher: FSWatcher | null = null
  private poll: NodeJS.Timeout | null = null
  private debounce: NodeJS.Timeout | null = null
  private draining = false
  private again = false
  private onEvent: ((ev: HookEvent) => void) | null = null

  /**
   * Watch `spool` and report every envelope dropped into it. Takes the folder
   * rather than finding it, so this class knows nothing about Electron and can
   * be tested against a temporary directory.
   */
  start(spool: string, onEvent: (ev: HookEvent) => void): void {
    this.spool = spool
    this.onEvent = onEvent
    // Anything already in the spool predates this launch: its panes are gone.
    // True only because the spool is keyed by pid — see hookPaths. While it was
    // shared, this line deleted another running window's in-flight events.
    void this.purge()
    this.attach()
    this.poll = setInterval(() => {
      if (!this.watcher) this.attach()
      this.schedule()
    }, POLL_MS)
  }

  /**
   * Consume whatever is in the spool now. Called by the poll, and directly by
   * tests, which must not race a debounce.
   */
  async drainNow(): Promise<void> {
    await this.drain()
  }

  stop(): void {
    this.watcher?.close()
    this.watcher = null
    if (this.poll) clearInterval(this.poll)
    this.poll = null
    if (this.debounce) clearTimeout(this.debounce)
    this.debounce = null
    this.onEvent = null
  }

  private attach(): void {
    if (!this.spool) return
    try {
      const w = watch(this.spool, { persistent: false }, () => this.schedule())
      w.on('error', () => {
        w.close()
        this.watcher = null // the poll re-arms
      })
      this.watcher = w
    } catch {
      this.watcher = null // directory not there yet — the poll retries
    }
  }

  private schedule(): void {
    if (this.debounce) return
    this.debounce = setTimeout(() => {
      this.debounce = null
      void this.drain()
    }, DRAIN_DEBOUNCE_MS)
  }

  /** Delete everything, envelopes and half-written temporaries alike. */
  private async purge(): Promise<void> {
    if (!this.spool) return
    try {
      for (const name of await readdir(this.spool)) {
        await unlink(join(this.spool, name)).catch(() => {})
      }
    } catch {
      // nothing to purge
    }
  }

  private async drain(): Promise<void> {
    if (this.draining) {
      this.again = true
      return
    }
    this.draining = true
    try {
      do {
        this.again = false
        await this.pass()
      } while (this.again)
    } finally {
      this.draining = false
    }
  }

  private async pass(): Promise<void> {
    const spool = this.spool
    if (!spool) return
    let names: string[]
    try {
      names = (await readdir(spool)).filter((n) => n.endsWith('.json'))
    } catch {
      return
    }
    const ordered: { file: string; mtime: number }[] = []
    for (const name of names) {
      const file = join(spool, name)
      try {
        ordered.push({ file, mtime: (await stat(file)).mtimeMs })
      } catch {
        // consumed by a concurrent pass
      }
    }
    ordered.sort((a, b) => a.mtime - b.mtime || a.file.localeCompare(b.file))

    for (const { file } of ordered) {
      let text: string
      try {
        text = await readFile(file, 'utf8')
      } catch {
        continue
      }
      // Unlink before dispatching: a listener that throws must not leave the
      // envelope behind to be replayed on the next tick, forever.
      await unlink(file).catch(() => {})
      const ev = parseEnvelope(text)
      if (ev) this.onEvent?.(ev)
    }
  }
}
