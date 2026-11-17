import type { WebContents } from 'electron'
import { watch } from 'fs'
import type { FSWatcher } from 'fs'
import { open, readdir, realpath, stat } from 'fs/promises'
import { basename, dirname, isAbsolute, join, normalize, relative } from 'path'
import { IPC } from '../shared/ipc'
import type { SquadReportFile, SquadReportText, SquadReportUpdate } from '../shared/ipc'
import { REPORTS_DIR, ROLE_ID_RE } from '../shared/roles'

/**
 * The reports a squad files: `<squadDir>/reports/<role>.md`, watched so the
 * lead's worker cards can show a dot the moment one lands and the Orchestra
 * panel can open it.
 *
 * A report is the squad's real output — the role prompts tell every worker to
 * write one before it stops — and without this the only way to know one had
 * arrived was to go and look.
 *
 * The renderer names the folder, so the folder is checked: only one this run's
 * prepareSquad made, or one with the shape prepareSquad gives every squad
 * folder (`<repo>-worktrees/<name>-squad`), which is what a restored squad
 * carries. Only `<role id>.md` files are listed or read, a read may not leave
 * the folder through a link, and none reads more than 256 KB. This is a
 * window onto one kind of folder, not a file reader the renderer can point
 * anywhere.
 *
 * fs.watch is quick but not to be trusted alone — it misses events on network
 * drives and some editors' atomic saves — so a slow poll backs it up, and a
 * short debounce folds an editor's burst of writes into one look.
 */

/** The most of one report the viewer is given. */
export const REPORT_READ_CAP = 256 * 1024
/** How often a watched folder is looked at whatever fs.watch says. */
export const REPORT_POLL_MS = 4000
/** How long a burst of change events is waited out before looking. */
export const REPORT_DEBOUNCE_MS = 300

/** One spelling per folder: Windows and macOS do not care about case. */
function dirKey(dir: string, platform: string = process.platform): string {
  const n = normalize(dir).replace(/[\\/]+$/, '')
  return platform === 'linux' ? n : n.toLowerCase()
}

/**
 * Whether the renderer may watch or read this folder. Pure.
 *
 * `granted` holds what prepareSquad handed out this run. Anything else must be
 * an absolute path, with no `..` in it, shaped the way prepareSquad shapes a
 * squad folder — so a squad restored from yesterday still gets its reports,
 * and a home directory or a repository does not.
 */
export function squadDirAllowed(dir: unknown, granted: ReadonlySet<string>): dir is string {
  if (typeof dir !== 'string' || dir === '' || dir.includes('\0') || !isAbsolute(dir)) return false
  if (dir.split(/[\\/]/).includes('..')) return false
  if (granted.has(dirKey(dir))) return true
  const n = normalize(dir).replace(/[\\/]+$/, '')
  return /^[^\\/]+-squad$/.test(basename(n)) && /^[^\\/]+-worktrees$/.test(basename(dirname(n)))
}

/** `<role id>.md` and nothing else: no paths, no dotfiles, no other files. Pure. */
export function reportNameOk(name: unknown): name is string {
  return typeof name === 'string' && name.endsWith('.md') && ROLE_ID_RE.test(name.slice(0, -3))
}

/**
 * The reports that are new or rewritten since `seen` (name -> signature).
 * Size and mtime together, because an editor can rewrite a file inside one
 * mtime tick and a report can be rewritten at the same length. Pure.
 */
export function changedReports(seen: ReadonlyMap<string, string>, now: SquadReportFile[]): string[] {
  return now.filter((r) => seen.get(r.name) !== signature(r)).map((r) => r.name)
}

function signature(r: SquadReportFile): string {
  return `${r.size}:${r.mtime}`
}

/** Call `fn` once things have been quiet for `ms`. */
export function debounce(fn: () => void, ms: number): { (): void; cancel(): void } {
  let timer: ReturnType<typeof setTimeout> | null = null
  const run = (): void => {
    if (timer !== null) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      fn()
    }, ms)
  }
  run.cancel = (): void => {
    if (timer !== null) clearTimeout(timer)
    timer = null
  }
  return run
}

/** Every report in a reports folder, by name. Empty when the folder is not there. */
async function listReports(reportsDir: string): Promise<SquadReportFile[]> {
  let names: string[]
  try {
    names = await readdir(reportsDir)
  } catch {
    return []
  }
  const out: SquadReportFile[] = []
  for (const name of names.filter(reportNameOk).sort()) {
    try {
      const st = await stat(join(reportsDir, name))
      if (st.isFile()) out.push({ name, size: st.size, mtime: st.mtimeMs })
    } catch {
      // Deleted between the listing and the look; it is simply not there.
    }
  }
  return out
}

interface Watch {
  dir: string
  refs: number
  seen: Map<string, string>
  watcher: FSWatcher | null
  poll: ReturnType<typeof setInterval>
  kick: ReturnType<typeof debounce>
  scanning: boolean
  again: boolean
}

export class SquadReports {
  private target: Pick<WebContents, 'send' | 'isDestroyed'> | null = null
  private granted = new Set<string>()
  private watches = new Map<string, Watch>()
  /** Watches less unwatches of a folder whose first look is still being read. */
  private pending = new Map<string, number>()
  /** Bumped by stopAll, so a watch it overtook knows not to set itself up. */
  private epoch = 0

  setTarget(wc: Pick<WebContents, 'send' | 'isDestroyed'>): void {
    this.target = wc
  }

  /** A folder prepareSquad just made. Allowed whatever its name. */
  grant(dir: string): void {
    this.granted.add(dirKey(dir))
  }

  /**
   * Watch a squad folder's reports and return what is there now, or null
   * when the folder is not one this will watch. Counted: two crews sharing a
   * folder watch it once, and it stops when the last lets go.
   */
  async watch(dir: unknown): Promise<SquadReportFile[] | null> {
    if (!squadDirAllowed(dir, this.granted)) return null
    const key = dirKey(dir)
    const reportsDir = join(dir, REPORTS_DIR)
    const existing = this.watches.get(key)
    if (existing) {
      existing.refs++
      return listReports(reportsDir)
    }
    // Not watched yet, and the first look takes a moment. Every watch and
    // unwatch of this folder in that moment is counted here, so an unwatch
    // that arrives before the watch it cancels is not lost; the first watch
    // in sets the folder up with whatever the count has come to.
    const inFlight = this.pending.get(key)
    this.pending.set(key, (inFlight ?? 0) + 1)
    const epoch = this.epoch
    const now = await listReports(reportsDir)
    // Another watch is setting this folder up, or stopAll ran while the list
    // was read and this watch is from a page that has gone.
    if (inFlight !== undefined || epoch !== this.epoch) return now
    const refs = this.pending.get(key) ?? 0
    this.pending.delete(key)
    if (refs <= 0) return now // let go of before it was ever set up
    const w: Watch = {
      dir,
      refs,
      seen: new Map(now.map((r) => [r.name, signature(r)])),
      watcher: null,
      poll: setInterval(() => void this.scan(w), REPORT_POLL_MS),
      kick: debounce(() => void this.scan(w), REPORT_DEBOUNCE_MS),
      scanning: false,
      again: false
    }
    w.poll.unref?.()
    try {
      // Missing until the squad's first report on a folder made by hand; the
      // poll notices it appear, and that is soon enough.
      w.watcher = watch(reportsDir, () => w.kick())
      w.watcher.on('error', () => {
        w.watcher?.close()
        w.watcher = null
      })
    } catch {
      w.watcher = null
    }
    this.watches.set(key, w)
    return now
  }

  unwatch(dir: unknown): void {
    if (typeof dir !== 'string') return
    const key = dirKey(dir)
    const w = this.watches.get(key)
    if (!w) {
      // Its watch is still being set up: take the count back down, and the
      // watch finds nothing left to set up for.
      const n = this.pending.get(key)
      if (n !== undefined && n > 0) this.pending.set(key, n - 1)
      return
    }
    if (--w.refs > 0) return
    this.close(w)
    this.watches.delete(key)
  }

  /** How many folders are being watched. For tests. */
  watching(): number {
    return this.watches.size
  }

  /**
   * One report's text, for the viewer — at most REPORT_READ_CAP of it. Null
   * for a folder or name this will not read, a link out of the folder, or a
   * file that is not there.
   */
  async read(dir: unknown, name: unknown): Promise<SquadReportText | null> {
    if (!squadDirAllowed(dir, this.granted) || !reportNameOk(name)) return null
    try {
      const reportsDir = await realpath(join(dir, REPORTS_DIR))
      const file = await realpath(join(reportsDir, name))
      // A link inside reports/ pointing somewhere else is the one way left
      // out of the folder, and it is closed here.
      const rel = relative(reportsDir, file)
      if (rel === '' || rel.startsWith('..') || isAbsolute(rel) || /[\\/]/.test(rel)) return null
      const handle = await open(file, 'r')
      try {
        const st = await handle.stat()
        if (!st.isFile()) return null
        const length = Math.min(st.size, REPORT_READ_CAP)
        const buf = Buffer.alloc(length)
        const { bytesRead } = await handle.read(buf, 0, length, 0)
        return {
          name,
          text: buf.subarray(0, bytesRead).toString('utf8'),
          truncated: st.size > REPORT_READ_CAP,
          mtime: st.mtimeMs
        }
      } finally {
        await handle.close()
      }
    } catch {
      return null
    }
  }

  /** Look at a watched folder now rather than at the next poll. For tests. */
  async rescan(dir: string): Promise<void> {
    const w = this.watches.get(dirKey(dir))
    if (w) await this.scan(w)
  }

  stopAll(): void {
    for (const w of this.watches.values()) this.close(w)
    this.watches.clear()
    // Watches still being set up belong to the page that asked for them.
    this.pending.clear()
    this.epoch++
  }

  private close(w: Watch): void {
    clearInterval(w.poll)
    w.kick.cancel()
    w.watcher?.close()
    w.watcher = null
  }

  private async scan(w: Watch): Promise<void> {
    // One look at a time per folder. A signal that lands mid-look is kept, so
    // the write that caused it is not missed.
    if (w.scanning) {
      w.again = true
      return
    }
    w.scanning = true
    try {
      do {
        w.again = false
        const now = await listReports(join(w.dir, REPORTS_DIR))
        const changed = changedReports(w.seen, now)
        const removed = [...w.seen.keys()].some((n) => !now.some((r) => r.name === n))
        w.seen = new Map(now.map((r) => [r.name, signature(r)]))
        if (changed.length > 0 || removed) this.send({ squadDir: w.dir, reports: now, changed })
      } while (w.again)
    } finally {
      w.scanning = false
    }
  }

  private send(update: SquadReportUpdate): void {
    if (this.target && !this.target.isDestroyed()) this.target.send(IPC.SquadReport, update)
  }
}
