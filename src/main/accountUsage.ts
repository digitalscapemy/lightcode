import { open, readdir, stat } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import {
  DayLedger,
  addTotals,
  lastDays,
  parseUsageLine,
  zeroTotals,
  type AccountUsage
} from '../shared/accountUsage'
import { providerOf } from '../shared/accountProviders'
import { loadShortcuts } from './shortcuts'

/**
 * Live token usage per Claude account: today and the last 7 days.
 *
 * Reads the session transcripts under each account's config folder
 * (<configDir>/projects/**\/*.jsonl). Only files touched in the last 8 days are
 * read, and after the first pass only the bytes added since — in chunks, with a
 * yield between files, so the main process never stalls on a big history.
 */

const READ_CHUNK = 256 * 1024
const MAX_AGE_MS = 8 * 86_400_000
const FRESH_MS = 10_000

interface FileTail {
  offset: number
  carry: string
  ledger: DayLedger
}

const tails = new Map<string, FileTail>()

const yieldNow = (): Promise<void> => new Promise((r) => setImmediate(r))

/** Every .jsonl under projects/, a few levels deep, touched in the window. */
async function transcriptFiles(root: string, since: number): Promise<string[]> {
  const out: string[] = []
  const walk = async (dir: string, depth: number): Promise<void> => {
    let entries: import('fs').Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = join(dir, e.name)
      if (e.isDirectory()) {
        if (depth < 4) await walk(p, depth + 1)
      } else if (e.name.endsWith('.jsonl')) {
        try {
          if ((await stat(p)).mtimeMs >= since) out.push(p)
        } catch {
          // vanished between list and stat
        }
      }
    }
  }
  await walk(join(root, 'projects'), 0)
  return out
}

/** Read what was added to a transcript since last time into its ledger. */
async function readNew(file: string): Promise<DayLedger> {
  let t = tails.get(file)
  if (!t) {
    t = { offset: 0, carry: '', ledger: new DayLedger() }
    tails.set(file, t)
  }
  let size: number
  try {
    size = (await stat(file)).size
  } catch {
    return t.ledger
  }
  if (size < t.offset) {
    // Rewritten or truncated: start over.
    t = { offset: 0, carry: '', ledger: new DayLedger() }
    tails.set(file, t)
  }
  if (size === t.offset) return t.ledger
  const fh = await open(file, 'r')
  try {
    const buf = Buffer.alloc(READ_CHUNK)
    while (t.offset < size) {
      const { bytesRead } = await fh.read(buf, 0, Math.min(READ_CHUNK, size - t.offset), t.offset)
      if (bytesRead === 0) break
      t.offset += bytesRead
      const text = t.carry + buf.toString('utf8', 0, bytesRead)
      const lines = text.split('\n')
      t.carry = lines.pop() ?? ''
      for (const line of lines) {
        const u = parseUsageLine(line)
        if (u) t.ledger.add(u)
      }
      await yieldNow()
    }
  } finally {
    await fh.close()
  }
  return t.ledger
}

function accounts(): { label: string; dir: string }[] {
  const list = [{ label: 'Default', dir: join(homedir(), '.claude') }]
  const seen = new Set([list[0]!.dir.toLowerCase()])
  // Only Claude accounts: the transcripts read here are Claude Code's.
  for (const a of loadShortcuts().accounts.filter((x) => providerOf(x) === 'claude')) {
    const dir = a.configDir.replace(/[\\/]+$/, '')
    if (!dir || seen.has(dir.toLowerCase())) continue
    seen.add(dir.toLowerCase())
    list.push({ label: a.name, dir })
  }
  return list
}

let cache: { at: number; data: AccountUsage[] } | null = null
let running: Promise<AccountUsage[]> | null = null

/** Usage for every account. Shared and cached for 10 s, so polling is cheap. */
export function accountUsage(): Promise<AccountUsage[]> {
  if (cache && Date.now() - cache.at < FRESH_MS) return Promise.resolve(cache.data)
  if (running) return running
  running = compute()
    .then((data) => {
      cache = { at: Date.now(), data }
      return data
    })
    .finally(() => {
      running = null
    })
  return running
}

async function compute(): Promise<AccountUsage[]> {
  const now = Date.now()
  const days = lastDays(now)
  const today = days[days.length - 1]!
  const result: AccountUsage[] = []
  for (const acc of accounts()) {
    const perDay = new Map(days.map((d) => [d, zeroTotals()]))
    let lastActivity: number | null = null
    for (const file of await transcriptFiles(acc.dir, now - MAX_AGE_MS)) {
      const ledger = await readNew(file)
      for (const [day, totals] of ledger.days) {
        const bucket = perDay.get(day)
        if (bucket) addTotals(bucket, totals)
      }
      if (ledger.lastTs !== null && (lastActivity === null || ledger.lastTs > lastActivity)) {
        lastActivity = ledger.lastTs
      }
      await yieldNow()
    }
    const last7 = zeroTotals()
    for (const t of perDay.values()) addTotals(last7, t)
    result.push({
      id: acc.dir.toLowerCase(),
      label: acc.label,
      configDir: acc.dir,
      today: perDay.get(today) ?? zeroTotals(),
      last7,
      days: days.map((day) => ({ day, totals: perDay.get(day)! })),
      lastActivity
    })
  }
  return result
}
