import type { PaneStatus } from '../shared/ipc'

/**
 * A guess at what an agent without hooks is doing, from its terminal alone.
 *
 * Claude Code says what it is doing (agentHooks.ts, the transcript). Codex and
 * Gemini say nothing the app can hear, so for them the dot is an estimate, and
 * is shown as one (≈). The estimate is the one a person makes glancing at a
 * terminal:
 *
 *  - Output after Enter means it is `working`. Enter rather than any key: the
 *    echo of somebody typing is output after input too, and is not a turn.
 *  - Quiet for a few seconds with something prompt-like on its last line means
 *    the turn ended: `waiting-input`. A TUI agent mid-turn redraws a timer or a
 *    spinner every second, so quiet is most of the signal; the tail only moves
 *    the line — sooner under a prompt, later under "esc to interrupt".
 *  - The shell's own prompt coming back means the agent has gone: `idle`.
 *
 * It never says `waiting-approval`. A permission menu and a finished turn look
 * the same from here, and an answer typed on a guess could be "yes, always" —
 * so the app never offers to approve on this estimate, and the babysitter
 * never acts on it.
 *
 * The rules are pure functions of a small state; QuietWatcher only adds the
 * clock and the per-pane bookkeeping.
 */

/** Quiet long enough, with a prompt on the last line, to call the turn over. */
export const PROMPT_QUIET_MS = 2_500
/** Quiet long enough to call it over on quiet alone, when nothing looks busy. */
export const QUIET_MS = 3_000
/**
 * Quiet while the screen still says it is busy. A working TUI redraws its
 * timer every second, so this much silence under "esc to interrupt" is a turn
 * that ended without wiping the line, or a frozen screen — not a turn running.
 */
export const BUSY_QUIET_MS = 8_000
/** How much of the recent output is kept to judge the tail by. */
const TAIL_CHARS = 600

// CSI, OSC (BEL or ST terminated), and the lone two-byte escapes.
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]|[\x00-\x08\x0b-\x1f\x7f]/g

/** A line that ends where something is waiting to be typed into. */
const PROMPT_END = /[>›❯»$#%:?▌│]\s*$/
/** Footer hints TUI agents draw under an empty input box. */
const PROMPT_HINT = /\b(?:send|for shortcuts|type your message|ask codex|to quit|newline)\b/i
/** What TUI agents draw while a turn is under way. */
const BUSY = /esc to (?:interrupt|cancel)|ctrl\+c to (?:interrupt|cancel)/i

export interface QuietState {
  status: PaneStatus
  /** Enter was pressed and nothing has answered it yet. */
  armed: boolean
  /** When the pane last printed, in ms. */
  lastOutput: number
  /** The recent output with escapes removed. */
  tail: string
}

export function quietState(): QuietState {
  return { status: 'idle', armed: false, lastOutput: 0, tail: '' }
}

/** Terminal output as text: escapes stripped, carriage returns made line breaks. */
export function plainText(data: string): string {
  return data.replace(ANSI, (m) => (m === '\r' ? '\n' : '')).replace(/\r/g, '\n')
}

/** The last line with anything on it. */
function lastLine(tail: string): string {
  const lines = tail.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trimEnd()
    if (line.trim() !== '') return line
  }
  return ''
}

/** The tail reads like an agent waiting to be typed into. */
export function promptLike(tail: string): boolean {
  const line = lastLine(tail)
  return PROMPT_END.test(line) || PROMPT_HINT.test(line) || PROMPT_HINT.test(tail.slice(-200))
}

/** The tail says a turn is still running. */
export function busyTail(tail: string): boolean {
  return BUSY.test(tail.slice(-300))
}

/**
 * How long quiet has to last before the turn counts as over: shorter with a
 * prompt in view, a little longer on quiet alone, and longest while the screen
 * still says it is busy.
 */
export function settleDelay(tail: string): number {
  if (busyTail(tail)) return BUSY_QUIET_MS
  return promptLike(tail) ? PROMPT_QUIET_MS : QUIET_MS
}

/** Something was typed. Only Enter starts a turn. */
export function noteInput(s: QuietState, data: string): void {
  if (/[\r\n]/.test(data)) s.armed = true
}

/**
 * The pane printed. Returns the new status when this changes it. Output with
 * nothing typed before it — a redraw on resize, a clock — changes nothing.
 */
export function noteOutput(s: QuietState, data: string, now: number): PaneStatus | null {
  s.lastOutput = now
  const text = plainText(data)
  if (text !== '') s.tail = (s.tail + text).slice(-TAIL_CHARS)
  if (!s.armed) return null
  s.armed = false
  if (s.status === 'working') return null
  s.status = 'working'
  return 'working'
}

/** Whether the turn has gone quiet enough to be over. Returns the new status, or null. */
export function settle(s: QuietState, now: number): PaneStatus | null {
  if (s.status !== 'working') return null
  if (now - s.lastOutput < settleDelay(s.tail)) return null
  s.status = 'waiting-input'
  return 'waiting-input'
}

/** The shell's prompt is back, so the agent has exited. */
export function notePrompt(s: QuietState): PaneStatus | null {
  s.armed = false
  s.tail = ''
  if (s.status === 'idle') return null
  s.status = 'idle'
  return 'idle'
}

/**
 * The clock and the panes. ptyManager feeds it only the panes opened for an
 * agent whose adapter says `heuristic`; `emit` is called on every change.
 */
export class QuietWatcher {
  private panes = new Map<string, { state: QuietState; timer: ReturnType<typeof setTimeout> | null }>()

  constructor(
    private emit: (paneId: string, status: PaneStatus, at: number) => void,
    private now: () => number = Date.now
  ) {}

  watch(paneId: string): void {
    this.forget(paneId)
    this.panes.set(paneId, { state: quietState(), timer: null })
  }

  watching(paneId: string): boolean {
    return this.panes.has(paneId)
  }

  input(paneId: string, data: string): void {
    const p = this.panes.get(paneId)
    if (p) noteInput(p.state, data)
  }

  output(paneId: string, data: string): void {
    const p = this.panes.get(paneId)
    if (!p) return
    const at = this.now()
    const changed = noteOutput(p.state, data, at)
    if (changed) this.emit(paneId, changed, at)
    if (p.state.status === 'working') this.schedule(paneId)
  }

  prompt(paneId: string): void {
    const p = this.panes.get(paneId)
    if (!p) return
    this.clear(p)
    const changed = notePrompt(p.state)
    if (changed) this.emit(paneId, changed, this.now())
  }

  forget(paneId: string): void {
    const p = this.panes.get(paneId)
    if (p) this.clear(p)
    this.panes.delete(paneId)
  }

  stopAll(): void {
    for (const id of [...this.panes.keys()]) this.forget(id)
  }

  /** One timer per pane, restarted by every bit of output while it works. */
  private schedule(paneId: string): void {
    const p = this.panes.get(paneId)
    if (!p) return
    this.clear(p)
    const delay = settleDelay(p.state.tail)
    p.timer = setTimeout(() => {
      p.timer = null
      const changed = settle(p.state, this.now())
      if (changed) this.emit(paneId, changed, this.now())
    }, delay)
  }

  private clear(p: { timer: ReturnType<typeof setTimeout> | null }): void {
    if (p.timer !== null) clearTimeout(p.timer)
    p.timer = null
  }
}
