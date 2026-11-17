/**
 * Token usage per Claude account (config folder), per day — shared shapes and
 * the pure parts, so they can be tested without a disk.
 *
 * Counted from the session transcripts on this computer, the same way the pane
 * badge counts (usageWatcher.ingest): assistant messages carry `usage`, and a
 * message streamed over several lines counts once, its last line winning. These
 * are not Anthropic's plan limits: the transcripts do not hold those, and usage
 * from other machines is not here.
 */

export interface TokenTotals {
  input: number
  output: number
  cacheRead: number
  cacheCreate: number
}

export interface AccountUsage {
  /** Stable id: the config folder, lower-cased. */
  id: string
  /** The shortcut name, or "Default" for ~/.claude. */
  label: string
  configDir: string
  today: TokenTotals
  last7: TokenTotals
  /** Oldest first, 7 entries ending today; day = YYYY-MM-DD (local). */
  days: { day: string; totals: TokenTotals }[]
  /** ms timestamp of the newest counted message, or null. */
  lastActivity: number | null
}

export function zeroTotals(): TokenTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 }
}

export function addTotals(into: TokenTotals, t: TokenTotals, sign = 1): void {
  into.input += sign * t.input
  into.output += sign * t.output
  into.cacheRead += sign * t.cacheRead
  into.cacheCreate += sign * t.cacheCreate
}

/** Tokens that count against a session, without the much cheaper cache reads. */
export function billable(t: TokenTotals): number {
  return t.input + t.output + t.cacheCreate
}

/** Local calendar day of a timestamp, YYYY-MM-DD. */
export function dayKey(ms: number): string {
  const d = new Date(ms)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** The last `n` local days ending with `now`'s day, oldest first. */
export function lastDays(now: number, n = 7): string[] {
  const out: string[] = []
  const d = new Date(now)
  d.setHours(12, 0, 0, 0) // noon: safe across DST changes
  for (let i = n - 1; i >= 0; i--) out.push(dayKey(d.getTime() - i * 86_400_000))
  return out
}

export interface UsageLine {
  /** Dedup key: one message, however many lines it streamed over. */
  key: string | null
  ts: number
  totals: TokenTotals
}

/** One transcript line → its usage, or null when it carries none. */
export function parseUsageLine(line: string): UsageLine | null {
  // Cheap gate before JSON.parse: most lines carry no usage at all.
  if (!line.includes('"usage"') || !line.includes('"assistant"')) return null
  let obj: {
    type?: string
    timestamp?: string
    requestId?: string
    uuid?: string
    message?: {
      id?: string
      model?: string
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
    return null
  }
  if (obj?.type !== 'assistant') return null
  const u = obj.message?.usage
  if (!u || obj.message?.model === '<synthetic>') return null
  const ts = obj.timestamp ? Date.parse(obj.timestamp) : NaN
  if (!Number.isFinite(ts)) return null
  const msgId = obj.message?.id
  return {
    key: msgId ? `${obj.requestId ?? ''}|${msgId}` : obj.uuid ? `u:${obj.uuid}` : null,
    ts,
    totals: {
      input: u.input_tokens ?? 0,
      output: u.output_tokens ?? 0,
      cacheRead: u.cache_read_input_tokens ?? 0,
      cacheCreate: u.cache_creation_input_tokens ?? 0
    }
  }
}

/**
 * Per-day totals for one transcript, built line by line. A message seen again
 * replaces its earlier count (in whichever day that landed), so streaming
 * never double-counts.
 */
export class DayLedger {
  readonly days = new Map<string, TokenTotals>()
  private seen = new Map<string, { day: string; totals: TokenTotals }>()
  lastTs: number | null = null

  add(u: UsageLine): void {
    const day = dayKey(u.ts)
    if (u.key !== null) {
      const prev = this.seen.get(u.key)
      if (prev) {
        const bucket = this.days.get(prev.day)
        if (bucket) addTotals(bucket, prev.totals, -1)
      }
      this.seen.set(u.key, { day, totals: u.totals })
    }
    let bucket = this.days.get(day)
    if (!bucket) {
      bucket = zeroTotals()
      this.days.set(day, bucket)
    }
    addTotals(bucket, u.totals)
    if (this.lastTs === null || u.ts > this.lastTs) this.lastTs = u.ts
  }
}

/** Short human form: 1234 → "1.2K", 3_400_000 → "3.4M". */
export function fmtTokens(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}
