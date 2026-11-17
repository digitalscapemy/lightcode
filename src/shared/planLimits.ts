/**
 * Plan limits per Claude account: how much of the 5-hour session and the
 * weekly limit is used, and when each resets. The same numbers as Claude
 * Code's /usage, read live rather than counted.
 *
 * Where they come from: Claude Code hands `rate_limits` to its status line
 * command on every refresh (a documented field, present for subscribers). In
 * Light Code panes the status line is a small script of ours that saves that
 * JSON to a file named after the account's config folder, then runs the
 * person's own status line, if any, and prints its output unchanged.
 * Nothing reads a login token, and nothing is sent anywhere.
 *
 * So the numbers are as fresh as the last reply in a Light Code pane with
 * that account. An account not used here yet has none, and the view says so.
 */

export interface LimitWindow {
  /** 0 to 100. */
  usedPercent: number
  /** ms epoch when the window resets. */
  resetsAt: number
}

export interface AccountLimits {
  /** Stable id: the config folder's file key. */
  id: string
  /** The shortcut name, or "Default" for ~/.claude. */
  label: string
  configDir: string
  /** The 5-hour session window, when Claude Code reported one. */
  fiveHour: LimitWindow | null
  /** The weekly window, when Claude Code reported one. */
  sevenDay: LimitWindow | null
  /** ms epoch of the status line refresh these came from, or null when never seen. */
  updatedAt: number | null
}

/**
 * The file name a config folder's limits are saved under. Case and separators
 * do not matter, so `C:\Users\me\.claude-1` and `c:/users/me/.claude-1/` meet.
 * The status line scripts compute exactly this (see main/planLimits.ts).
 */
export function limitsKey(configDir: string): string {
  return configDir
    .replace(/[\\/]+$/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '_')
}

function window(raw: unknown): LimitWindow | null {
  if (!raw || typeof raw !== 'object') return null
  const w = raw as { used_percentage?: unknown; resets_at?: unknown }
  if (typeof w.used_percentage !== 'number' || !Number.isFinite(w.used_percentage)) return null
  if (typeof w.resets_at !== 'number' || !Number.isFinite(w.resets_at)) return null
  return {
    usedPercent: Math.max(0, w.used_percentage),
    // Seconds per the status line docs; tolerate milliseconds too.
    resetsAt: w.resets_at > 1e12 ? w.resets_at : w.resets_at * 1000
  }
}

/** The two windows out of one status line JSON document. Never throws. */
export function parseStatusLine(text: string): { fiveHour: LimitWindow | null; sevenDay: LimitWindow | null } {
  try {
    const doc = JSON.parse(text) as { rate_limits?: { five_hour?: unknown; seven_day?: unknown } }
    const rl = doc?.rate_limits
    return { fiveHour: window(rl?.five_hour), sevenDay: window(rl?.seven_day) }
  } catch {
    return { fiveHour: null, sevenDay: null }
  }
}
