import type { CrewEvent } from '../../shared/crew'
import type { PaneStatus } from '../../shared/ipc'

/**
 * The crew event stream behind `lc events`: what a lead waits on instead of
 * polling every worker in turn.
 *
 * A ring of the last few hundred events, each numbered, and the callers
 * currently waiting for the next one. A lead asks "anything since #41?"; if
 * there is, it is answered at once, and if not the question is held until an
 * event it may see arrives or its time runs out. Nothing here knows about
 * panes or the DOM — what an event says is decided by whoever pushes it.
 *
 * Only crew members produce events, so a window with no orchestra pushes
 * nothing and holds nothing.
 */

/** A status in the word `lc ls` shows it as — and `lc events` with it. */
export const STATUS_WORD: Record<PaneStatus, string> = {
  working: 'working',
  'waiting-input': 'waiting',
  'waiting-approval': 'approval',
  idle: 'idle'
}

/** The start of some text, on one line, for an event that mentions it. */
export function firstWords(text: string, max = 80): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/**
 * An event in a few words, for the Orchestra panel's timeline: "waiting",
 * "sent by @lead: run the tests", "filed developer.md".
 */
export function eventText(e: Pick<CrewEvent, 'kind' | 'state' | 'by' | 'detail'>): string {
  const by = e.by ? ` by ${e.by}` : ''
  const detail = e.detail ? `: ${e.detail}` : ''
  switch (e.kind) {
    case 'status':
      return `${e.state ?? 'status'}${detail}`
    case 'reported':
      return `filed ${e.detail ?? 'a report'}`
    default:
      return `${e.kind}${by}${detail}`
  }
}

/** How many events are kept. A lead further behind than this is told so. */
export const CREW_EVENT_CAP = 500

export type CrewEventInput = Omit<CrewEvent, 'seq' | 'at'>

/** What a read hands back: the events, the newest seq, and whether some were lost. */
export interface CrewEventPage {
  events: CrewEvent[]
  /** The newest seq in the log, whether or not this page shows it. Pass it back as `since`. */
  seq: number
  /** Events after `since` that fell off the ring before they were asked for. */
  dropped: number
}

interface Waiter {
  since: number
  see: (e: CrewEvent) => boolean
  settle: (page: CrewEventPage) => void
  timer: ReturnType<typeof setTimeout>
}

export class CrewEventLog {
  private ring: CrewEvent[] = []
  private last = 0
  private waiters = new Set<Waiter>()
  private listeners = new Set<(e: CrewEvent) => void>()

  constructor(private readonly cap = CREW_EVENT_CAP) {}

  /** The newest seq handed out; 0 before the first event. */
  latest(): number {
    return this.last
  }

  push(input: CrewEventInput, at = Date.now()): CrewEvent {
    const event: CrewEvent = { ...input, seq: ++this.last, at }
    this.ring.push(event)
    if (this.ring.length > this.cap) this.ring.splice(0, this.ring.length - this.cap)
    for (const w of [...this.waiters]) {
      if (event.seq > w.since && w.see(event)) this.finish(w, this.since(w.since, w.see))
    }
    for (const listener of [...this.listeners]) listener(event)
    return event
  }

  /**
   * Hear every event as it is pushed — the Orchestra panel's timeline, while
   * the panel is open. Returns the unsubscribe.
   */
  listen(listener: (e: CrewEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** The newest `n` events, oldest first. */
  recent(n: number): CrewEvent[] {
    return n > 0 ? this.ring.slice(-n) : []
  }

  /** Every kept event after `since` that `see` lets through, oldest first. */
  since(since: number, see: (e: CrewEvent) => boolean = () => true): CrewEventPage {
    const oldest = this.ring[0]?.seq ?? this.last + 1
    // Seqs since+1 .. oldest-1 existed and are gone. Not filtered by `see` —
    // nobody can say any more whose they were — so this is an upper bound.
    const dropped = Math.max(0, oldest - 1 - Math.max(since, 0))
    return { events: this.ring.filter((e) => e.seq > since && see(e)), seq: this.last, dropped }
  }

  /**
   * Events after `since`, now if there are any, otherwise as soon as one that
   * `see` lets through is pushed — or an empty page once `timeoutMs` passes.
   * A wait that runs out is not a failure: nothing happened, and saying so is
   * the answer.
   */
  wait(since: number, timeoutMs: number, see: (e: CrewEvent) => boolean = () => true): Promise<CrewEventPage> {
    const now = this.since(since, see)
    if (now.events.length > 0 || now.dropped > 0) return Promise.resolve(now)
    return new Promise((resolve) => {
      const waiter: Waiter = {
        since,
        see,
        settle: resolve,
        timer: setTimeout(() => this.finish(waiter, this.since(since, see)), timeoutMs)
      }
      this.waiters.add(waiter)
    })
  }

  /** How many callers are waiting right now. For tests, and for nothing else. */
  waiting(): number {
    return this.waiters.size
  }

  private finish(w: Waiter, page: CrewEventPage): void {
    if (!this.waiters.delete(w)) return
    clearTimeout(w.timer)
    w.settle(page)
  }
}

/** The one log the app keeps. */
export const crewEvents = new CrewEventLog()
