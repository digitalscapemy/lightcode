import type { PaneStatus } from '../../shared/ipc'
import { paneStatus } from './store'

/**
 * Auto-continue "babysitter": when enabled on a pane, it nudges Claude to keep
 * going after it finishes a turn, so long autonomous runs don't stall while the
 * user is away.
 *
 * Safety, by design:
 *  - Opt-in per pane; off by default.
 *  - Only fires on `waiting-input` (the turn genuinely ended). It NEVER acts on
 *    `waiting-approval` — permission prompts always need a human.
 *  - Caps at MAX_NUDGES consecutive auto-nudges, then stands down until the
 *    user intervenes (types in the pane) or re-toggles it.
 */

const MAX_NUDGES = 5
/**
 * Grace period after a turn ends before nudging. This is the whole wait: main
 * now reports `waiting-input` the moment the stop_reason lands, where it used
 * to sit on a ~4s timer first.
 */
const IDLE_THRESHOLD_MS = 12_000
export const DEFAULT_NUDGE = 'continue'

interface Sitter {
  on: boolean
  nudge: string
  count: number
  timer: number | null
}

const sitters = new Map<string, Sitter>()
let onChange: (() => void) | null = null

function get(paneId: string): Sitter {
  let s = sitters.get(paneId)
  if (!s) {
    s = { on: false, nudge: DEFAULT_NUDGE, count: 0, timer: null }
    sitters.set(paneId, s)
  }
  return s
}

export function isBabysitterOn(paneId: string): boolean {
  return sitters.get(paneId)?.on ?? false
}

export function babysitterCount(paneId: string): number {
  return sitters.get(paneId)?.count ?? 0
}

export const babysitterMax = MAX_NUDGES

/** True when the pane hit its nudge cap and is waiting for the user. */
export function babysitterCapped(paneId: string): boolean {
  const s = sitters.get(paneId)
  return !!s && s.on && s.count >= MAX_NUDGES
}

/** Toggle (or set) babysitter for a pane. Returns the new on/off state. */
export function toggleBabysitter(paneId: string, on?: boolean): boolean {
  const s = get(paneId)
  s.on = on ?? !s.on
  s.count = 0
  clearTimer(s)
  if (s.on && paneStatus.get(paneId)?.status === 'waiting-input') arm(paneId, s)
  notify()
  return s.on
}

/** Human typed in the pane — reset the consecutive-nudge counter. */
export function noteManualInput(paneId: string): void {
  const s = sitters.get(paneId)
  if (!s || !s.on || s.count === 0) return
  s.count = 0
  notify()
}

/** Drop all state for a pane that no longer exists. */
export function forgetPane(paneId: string): void {
  const s = sitters.get(paneId)
  if (s) clearTimer(s)
  sitters.delete(paneId)
}

/** Called by Mission Control to re-render when nudge counts change. */
export function onBabysitterChange(cb: () => void): void {
  onChange = cb
}

function notify(): void {
  onChange?.()
}

function clearTimer(s: Sitter): void {
  if (s.timer !== null) {
    window.clearTimeout(s.timer)
    s.timer = null
  }
}

function arm(paneId: string, s: Sitter): void {
  clearTimer(s)
  if (s.count >= MAX_NUDGES) return // capped — wait for manual reset
  s.timer = window.setTimeout(() => {
    s.timer = null
    if (!s.on || s.count >= MAX_NUDGES) return
    // Re-check: only nudge if still genuinely waiting for input.
    if (paneStatus.get(paneId)?.status !== 'waiting-input') return
    window.lightclaude.pty.write(paneId, s.nudge + '\r')
    s.count++
    notify()
  }, IDLE_THRESHOLD_MS)
}

/** Status sink hook — called by app.applyStatus on every transition. */
export function handleStatusChange(paneId: string, next: PaneStatus): void {
  const s = sitters.get(paneId)
  if (!s || !s.on) return
  if (next === 'waiting-input') arm(paneId, s)
  else clearTimer(s) // working / waiting-approval / idle → stand down
}
