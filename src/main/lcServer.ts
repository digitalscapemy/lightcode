import { app } from 'electron'
import type { WebContents } from 'electron'
import { chmodSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs'
import { createServer } from 'net'
import type { Server, Socket } from 'net'
import { join } from 'path'
import { IPC } from '../shared/ipc'
import { LC_OFF_MESSAGE, LC_PIPE_PREFIX, LC_PROTOCOL, LC_SOCKET_NAME } from '../shared/lc'
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

export function socketPath(): string {
  if (process.platform === 'win32') return `${LC_PIPE_PREFIX}${process.pid}`
  return join(app.getPath('userData'), LC_SOCKET_NAME)
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

  isEnabled(): boolean {
    return this.enabled
  }

  /**
   * Turn the door on or off. Off closes the socket outright rather than
   * answering "refused" — a socket that is not there cannot be probed, and a
   * switch that leaves the listener running is not really a switch.
   */
  setEnabled(on: boolean): void {
    if (on === this.enabled) return
    this.enabled = on
    if (on) this.listen()
    else this.stop()
  }

  private listen(): void {
    const path = socketPath()
    // A previous run that was killed rather than closed leaves the file behind,
    // and bind fails on an existing path.
    try {
      if (process.platform !== 'win32') unlinkSync(path)
    } catch {
      // nothing there, which is the normal case
    }
    const server = createServer((conn) => this.serve(conn))
    server.on('error', () => this.stop())
    try {
      server.listen(path, () => {
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
      })
      this.server = server
    } catch {
      this.server = null
    }
  }

  stop(): void {
    this.server?.close()
    this.server = null
    for (const settle of this.pending.values()) {
      settle({ ok: false, protocol: LC_PROTOCOL, error: LC_OFF_MESSAGE })
    }
    this.pending.clear()
    try {
      if (process.platform !== 'win32') unlinkSync(socketPath())
    } catch {
      // already gone
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
