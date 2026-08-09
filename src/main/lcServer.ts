import { app } from 'electron'
import type { WebContents } from 'electron'
import { chmodSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs'
import { createServer } from 'net'
import type { Server, Socket } from 'net'
import { join } from 'path'
import { IPC } from '../shared/ipc'
import {
  LC_OFF_MESSAGE,
  LC_PIPE_PREFIX,
  LC_PROTOCOL,
  LC_SOCKET_PREFIX,
  LC_SOCKET_SUFFIX
} from '../shared/lc'
import type { LcRequest, LcResponse } from '../shared/lc'

/**
 * The door `lc` comes through.
 *
 * A socket, never a network port. Nothing here binds to localhost or anything
 * else reachable from off the machine — a terminal multiplexer has no business
 * listening on TCP, and a port is a door you cannot see.
 *
 * What this file does NOT do is answer questions. Everything `lc` asks about —
 * pane status, token counts, branches, scrollback — lives in the renderer, so
 * a request is forwarded there and the reply carried back. This process only
 * owns the socket, the on/off switch, and the timeout.
 *
 * On the switch: it is off until turned on, and this is the one thing here that
 * is stricter than the prior art. A socket at 0600 keeps other *users* out; it
 * cannot keep out other programs running as you, and it never could, because
 * letting a program running as you type into a pane is the entire feature. So
 * the protection is not prevention. It is that nothing listens until you say
 * so, and that every pane says when something drove it.
 */

/** A renderer that never answers must not hang the caller for ever. */
const RENDERER_TIMEOUT_MS = 15_000
/** Long enough for `wait --for idle` on a real agent turn to come back. */
const LONG_TIMEOUT_MS = 15 * 60_000
/** One request is one line; anything larger is not a request we made. */
const MAX_REQUEST_BYTES = 256 * 1024

/**
 * Where this instance listens — one path per running app, hence the pid.
 *
 * It used to be a single fixed `lc.sock` for everyone, and two Light Codes at
 * once is an ordinary Tuesday: `npm run dev` beside the installed app, or a
 * second `open -n`. The one that started later unlinked the live socket of the
 * one already running and bound its own at the same path. The first app went on
 * saying the CLI was on while listening on an inode nothing could reach, and
 * every `lc` from its panes landed in the other window instead — `lc ls` listing
 * a stranger's panes in a stranger's repository, `lc send` typing into them,
 * `lc close` closing them. Worst of all, no row in that list matched the caller,
 * so none came back marked `*`; an agent obeying the one rule it is given about
 * `lc` — never drive your own pane, it is the one with the asterisk — read a
 * list with no asterisk as a list where everything was safe to drive.
 *
 * Windows already worked this way. This is POSIX catching up, and it keeps the
 * two-instances workflow rather than taking it away with a single-instance lock.
 */
export function socketPath(): string {
  if (process.platform === 'win32') return `${LC_PIPE_PREFIX}${process.pid}`
  return join(app.getPath('userData'), `${LC_SOCKET_PREFIX}${process.pid}${LC_SOCKET_SUFFIX}`)
}

/**
 * The pid a socket filename belongs to, or null when the name is not one we
 * wrote. Deliberately strict — the sweep below deletes whatever this returns a
 * pid for, and a loose match is how you end up unlinking a live instance's door
 * again by another route.
 */
export function socketOwnerPid(name: string): number | null {
  if (!name.startsWith(LC_SOCKET_PREFIX) || !name.endsWith(LC_SOCKET_SUFFIX)) return null
  const digits = name.slice(LC_SOCKET_PREFIX.length, name.length - LC_SOCKET_SUFFIX.length)
  if (!/^[1-9][0-9]*$/.test(digits)) return null
  return Number(digits)
}

/**
 * Sockets left behind by runs that were killed rather than closed.
 *
 * Only ones whose process is gone. A pid that still answers may well be a Light
 * Code somebody is using, and deleting its socket is the exact accident the pid
 * in the name exists to prevent — so an unrecognised or still-living pid is left
 * alone, and the worst that costs is a dead file nobody looks at. Not sweeping
 * at all would be safe too, but then every crash leaves one behind for good.
 */
function sweepDeadSockets(dir: string): void {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return
  }
  for (const name of names) {
    const pid = socketOwnerPid(name)
    if (pid === null || pid === process.pid) continue
    try {
      process.kill(pid, 0)
      continue // answers, so it is somebody's — leave it
    } catch (err) {
      // EPERM is a live process owned by another user. Only ESRCH means gone.
      if ((err as NodeJS.ErrnoException).code !== 'ESRCH') continue
    }
    try {
      unlinkSync(join(dir, name))
    } catch {
      // another instance swept it first
    }
  }
}

function reply(res: LcResponse): string {
  return `${JSON.stringify(res)}\n`
}

function fail(error: string): string {
  return reply({ ok: false, protocol: LC_PROTOCOL, error })
}

/**
 * Parse one line into a request, or say why it is not one.
 *
 * Pure and hostile-input safe: anything at all can be written to this socket,
 * so a malformed line has to be answerable rather than throwable.
 */
export function parseRequest(line: string): { req: LcRequest } | { error: string } {
  let raw: unknown
  try {
    raw = JSON.parse(line)
  } catch {
    return { error: 'Request was not JSON.' }
  }
  if (typeof raw !== 'object' || raw === null) return { error: 'Request was not an object.' }
  const cmd = (raw as { cmd?: unknown }).cmd
  if (typeof cmd !== 'string') return { error: 'Request had no cmd.' }
  const known = ['ls', 'read', 'send', 'close', 'wait', 'fan']
  if (!known.includes(cmd)) {
    return { error: `Unknown command "${cmd}". Known: ${known.join(', ')}.` }
  }
  return { req: raw as LcRequest }
}

/** Commands that hold the line open while something happens elsewhere. */
export function timeoutFor(req: LcRequest): number {
  if (req.cmd === 'wait') return Math.min(req.timeoutMs + 5_000, LONG_TIMEOUT_MS)
  if (req.cmd === 'fan') return LONG_TIMEOUT_MS
  return RENDERER_TIMEOUT_MS
}

export class LcServer {
  private server: Server | null = null
  private target: WebContents | null = null
  private enabled = false
  /** Set only between a bind that succeeded and the close that undoes it. */
  private bound = false
  /** Serialises setEnabled, so no two binds are ever in flight at once. */
  private queue: Promise<void> = Promise.resolve()
  private nextId = 1
  private pending = new Map<number, (res: LcResponse) => void>()

  setTarget(wc: WebContents): void {
    this.target = wc
  }

  /** The renderer answering a forwarded request. Registered once, in main. */
  handleReply(id: number, res: LcResponse): void {
    const settle = this.pending.get(id)
    if (!settle) return // timed out already; the caller has been told
    this.pending.delete(id)
    settle(res)
  }

  /**
   * Whether `lc` can be reached right now — a fact about the socket, not a
   * memory of what was last asked for. This drives the switch in Mission
   * Control, and it used to say yes the instant somebody clicked it: a bind
   * that then failed left the dot lit over a door that was never opened, and
   * the first anyone heard of it was `lc` telling an agent nothing was there.
   */
  isEnabled(): boolean {
    return this.enabled
  }

  /**
   * Turn the door on or off. Off closes the socket outright rather than
   * answering "refused" — a socket that is not there cannot be probed, and a
   * switch that leaves the listener running is not really a switch.
   *
   * Resolves once the bind has actually succeeded or failed, so the caller can
   * report what happened instead of what was intended.
   *
   * Queued rather than merely awaited: a second click arriving while the first
   * bind is in flight would otherwise start a second listener on the same path,
   * and two servers racing over one socket is the very thing the pid in the
   * name is there to rule out.
   */
  setEnabled(on: boolean): Promise<void> {
    const done = this.queue.then(() => this.applyEnabled(on))
    this.queue = done.catch(() => {}) // one bad step must not wedge the switch
    return done
  }

  private async applyEnabled(on: boolean): Promise<void> {
    if (on === this.enabled) return
    if (on) await this.listen()
    else this.stop()
  }

  private listen(): Promise<void> {
    const path = socketPath()
    if (process.platform !== 'win32') {
      sweepDeadSockets(app.getPath('userData'))
      // Safe only because the name carries our own pid: no other live process
      // can be listening here, so anything at this path is this app's own
      // corpse from a run that was killed before it could clean up — and bind
      // fails if it stays. Deleting a fixed shared path on this line is what
      // let one window steal another's socket.
      try {
        unlinkSync(path)
      } catch {
        // nothing there, which is the normal case
      }
    }
    return new Promise((done) => {
      let settled = false
      const finish = (): void => {
        if (settled) return
        settled = true
        done()
      }
      const server = createServer((conn) => this.serve(conn))
      server.on('error', () => {
        this.stop()
        finish()
      })
      try {
        server.listen(path, () => {
          this.bound = true
          this.enabled = true
          // Owner only. Meaningful on POSIX; named pipes on Windows are governed
          // by an ACL this does not set, which is why Windows is not claimed to
          // be protected here.
          if (process.platform !== 'win32') {
            try {
              chmodSync(path, 0o600)
            } catch {
              // the bind succeeded; a failed chmod is worth knowing but not fatal
            }
          }
          finish()
        })
        this.server = server
      } catch {
        this.server = null
        finish()
      }
    })
  }

  stop(): void {
    const bound = this.bound
    this.bound = false
    this.enabled = false
    this.server?.close()
    this.server = null
    for (const settle of this.pending.values()) {
      settle({ ok: false, protocol: LC_PROTOCOL, error: LC_OFF_MESSAGE })
    }
    this.pending.clear()
    // Only a path this process is known to have bound. Cleaning up after a bind
    // that failed would mean deleting a file on the strength of a guess about
    // who owns it, which is the habit that caused all this.
    if (bound && process.platform !== 'win32') {
      try {
        unlinkSync(socketPath())
      } catch {
        // already gone
      }
    }
  }

  private serve(conn: Socket): void {
    let buf = ''
    let answered = false
    conn.setEncoding('utf8')
    conn.on('error', () => conn.destroy())
    conn.on('data', (chunk: string) => {
      if (answered) return
      buf += chunk
      if (buf.length > MAX_REQUEST_BYTES) {
        answered = true
        conn.end(fail('Request too large.'))
        return
      }
      const nl = buf.indexOf('\n')
      if (nl === -1) return
      answered = true
      void this.dispatch(buf.slice(0, nl)).then((res) => conn.end(res))
    })
  }

  private async dispatch(line: string): Promise<string> {
    if (!this.enabled) return fail(LC_OFF_MESSAGE)
    const parsed = parseRequest(line)
    if ('error' in parsed) return fail(parsed.error)

    const target = this.target
    if (!target || target.isDestroyed()) return fail('The app window is not ready.')

    const id = this.nextId++
    const answer = new Promise<LcResponse>((resolve) => {
      this.pending.set(id, resolve)
      setTimeout(() => {
        if (!this.pending.delete(id)) return
        resolve({ ok: false, protocol: LC_PROTOCOL, error: 'The app did not answer in time.' })
      }, timeoutFor(parsed.req))
    })
    target.send(IPC.LcRequest, id, parsed.req)
    return reply(await answer)
  }
}

/** Where the switch is remembered. Its own file, so it survives a state reset. */
function switchFile(): string {
  return join(app.getPath('userData'), 'lc', 'enabled.json')
}

/** Off unless a previous run was explicitly told otherwise. */
export function loadLcEnabled(): boolean {
  try {
    return JSON.parse(readFileSync(switchFile(), 'utf8')).enabled === true
  } catch {
    return false
  }
}

export function saveLcEnabled(enabled: boolean): void {
  try {
    mkdirSync(join(app.getPath('userData'), 'lc'), { recursive: true })
    writeFileSync(switchFile(), JSON.stringify({ enabled }), 'utf8')
  } catch {
    // the switch still works for this run; it just will not be remembered
  }
}
