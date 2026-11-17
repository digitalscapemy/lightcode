import { AGENTS, DEFAULT_AGENT } from '../../shared/agents'
import type { CrewSettings, PaneNodeCrew } from '../../shared/types'
import type { PaneStatus, StatusUpdate } from '../../shared/ipc'
import type { LcWaitFor } from '../../shared/lc'

/**
 * The rules `lc` drives panes by, kept apart from the code that drives them.
 *
 * Pure: no DOM, no store, no timers. Everything here is a decision made from
 * facts handed in, which is what lets it be tested — and what lets a button in
 * the app ask the same question an agent's command does, rather than the two
 * growing their own answers.
 *
 * The house rule is warn, never block. The few refusals here are not limits on
 * the person at the keyboard; they protect that person from an agent typing
 * somewhere its keys would do something nobody asked for.
 */

export type Gate = { allow: true; warning?: string } | { allow: false; error: string }

/**
 * Whether typing `text` into a menu could pick something in it.
 *
 * A menu acts on keystrokes as they arrive, so what matters is what is typed
 * first, not the message as a whole: "y" then a newline and an essay is a yes,
 * and "1. Run the tests" chooses option 1 before the rest is read. So: an empty
 * send (a bare Enter confirms the highlighted row), a first line that is a
 * reply on its own, a first character that is a digit or a menu hotkey letter
 * (y, a, n — Codex answers on the key itself, so "yeah, go on" is a yes and
 * "now do X" a no), or any control or escape character other than tab and
 * line breaks (arrow keys, Esc). Only agents are held to this, and an agent
 * can always open with another word.
 */
export function looksLikePromptAnswer(text: string): boolean {
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) return true
  // Not trimStart(): a leading line break is itself an Enter, which confirms
  // whatever row the menu has highlighted.
  const first = text.split(/\r?\n|\r/)[0]!.trim()
  if (first === '') return true
  if (/^[0-9yna]/i.test(first)) return true
  return (
    /^[a-z0-9]{1,2}[.!]?$/i.test(first) ||
    /^(yes|no|ok|okay|allow|deny|always|approve|accept|reject|y\/n)[.!]?$/i.test(first)
  )
}

/**
 * Whether `lc send` may type into a pane, and what to say about it if so.
 *
 * - Your own pane: refused. The text would land in the prompt of the very
 *   agent that sent it, interrupting the turn that is waiting on the answer.
 *   It used to be only a sentence in the system prompt, which is a rule an
 *   agent can forget and the app cannot.
 * - A pane showing a permission prompt: refused unless forced. Keystrokes
 *   there do not reach the agent at all — they answer the menu, so a message
 *   meant as an instruction becomes a yes or a no to some tool call.
 * - A pane mid-turn: sent, with a warning. The agent will read it when it gets
 *   to it; whoever sent it should know it was not read straight away.
 * - A pane whose status is only estimated (Codex, a shell, …), from an agent:
 *   a reply-sized send — y, n, 1, yes, a bare Enter — is refused unless
 *   forced. The app cannot see a permission prompt in such a pane, so the
 *   check above never fires there, and those are exactly the keys that would
 *   answer one. Real instructions still go through; the person at the
 *   keyboard (`byAgent` false) is never stopped.
 */
export function sendGate(o: {
  target: string
  from: string | undefined
  status: PaneStatus | undefined
  force: boolean
  /** Where the status came from; 'heuristic' means a prompt may be invisible. */
  source?: StatusUpdate['source']
  /** The text being sent, to recognise a prompt-sized answer. */
  text?: string
  /** True when an agent (`lc`) is sending rather than the person. */
  byAgent?: boolean
}): Gate {
  if (o.from !== undefined && o.from === o.target) {
    return {
      allow: false,
      error:
        `${o.target} is your own pane, sending to it would type into the turn that sent it. ` +
        '`lc ls` marks your pane with an asterisk.'
    }
  }
  if (o.status === 'waiting-approval') {
    if (!o.force) {
      return {
        allow: false,
        error:
          `${o.target} is showing a permission prompt, and the text would answer it rather than ` +
          'reach the agent. Leave it for the person at the screen, or add --force if answering ' +
          'the prompt is really what you mean.'
      }
    }
    return { allow: true, warning: `${o.target} was showing a permission prompt; --force sent the text into it.` }
  }
  if (o.byAgent && o.source === 'heuristic' && !o.force && looksLikePromptAnswer(o.text ?? '')) {
    return {
      allow: false,
      error:
        `${o.target}'s status is only estimated, so a permission prompt there would be invisible ` +
        `to Light Code, and "${(o.text ?? '').trim() || 'Enter'}" is the kind of reply that ` +
        'would answer one. Start the message with a word that is not y…, n…, a… or a digit ' +
        '(“Please …” works), or add --force if answering is what you mean.'
    }
  }
  if (o.status === 'working') {
    return {
      allow: true,
      warning: `${o.target} is mid-turn; the text was queued and will be read when it gets to it.`
    }
  }
  return { allow: true }
}

/** One write to a pty, made `delayMs` after the one before it. */
export interface Keystroke {
  data: string
  delayMs: number
}

const PASTE_START = '\x1b[200~'
const PASTE_END = '\x1b[201~'

/**
 * How long Enter waits after a bracketed paste.
 *
 * A TUI reads a paste as one event and needs a moment to settle it into its
 * input box; an Enter arriving in the same chunk can be swallowed into the
 * paste as a newline, leaving the message typed but never submitted.
 */
export const PASTE_ENTER_DELAY_MS = 60

/**
 * The writes that type `text` into a pane.
 *
 * One line goes in exactly as it always has: the text and Enter in one write.
 *
 * Several lines are the problem. Typed raw, every newline is an Enter, so an
 * agent's prompt box submits the first line alone and the rest arrive as
 * separate, half-finished messages — or, at a shell, as separate commands. A
 * bracketed paste marks the whole block as one piece of text, which is what a
 * person pasting it would have produced. Only when the program in the pane has
 * asked for that, though (`bracketed`): one that has not would print the
 * markers as junk, so it gets today's single raw write instead.
 *
 * The paste markers are stripped from the text itself, or a payload could close
 * the paste early and have everything after it typed live.
 */
export function sendKeystrokes(text: string, enter: boolean, bracketed: boolean): Keystroke[] {
  const multiline = /[\r\n]/.test(text)
  if (!multiline || !bracketed) return [{ data: enter ? `${text}\r` : text, delayMs: 0 }]
  // Line endings as xterm's own paste sends them: a terminal's Enter is \r.
  const body = text.split(PASTE_START).join('').split(PASTE_END).join('').replace(/\r?\n/g, '\r')
  const writes: Keystroke[] = [{ data: `${PASTE_START}${body}${PASTE_END}`, delayMs: 0 }]
  if (enter) writes.push({ data: '\r', delayMs: PASTE_ENTER_DELAY_MS })
  return writes
}

/**
 * How long a sent message may go unanswered before `lc wait` stops expecting
 * an agent to pick it up. Long enough for a busy agent to fire its next hook,
 * short enough that a wait on a pane where nothing is listening comes back
 * with a reason instead of sitting out its whole timeout.
 */
export const SEND_EXPECT_MS = 10_000

/**
 * Whether a send with Enter should make `lc wait` expect a fresh report.
 *
 * Only where an agent is there to answer: a plain shell has no turn, so a wait
 * on it keeps saying so at once instead of after the expectation lapses. And
 * not to an agent already `working`: there is no stale `waiting` to guard
 * against, and an agent deep in one long tool call reports nothing new — its
 * status is deduplicated, and a message typed mid-turn fires no prompt hook —
 * so the lapse would call a busy agent absent. Its own `working` keeps a wait
 * for `idle` pending until the turn really ends.
 */
export function sendExpectsReply(o: {
  enter: boolean
  status: PaneStatus | undefined
  expecting: boolean
}): boolean {
  if (!o.enter || o.status === 'working') return false
  return o.status !== undefined || o.expecting
}

/** What `lc wait` knows about one pane at one moment. */
export interface WaitView {
  exists: boolean
  exited: boolean
  status: PaneStatus | undefined
  /** An agent was asked for — a launch, or a message sent — and has not reported. */
  expecting: boolean
  /** A message was sent and nothing picked it up within SEND_EXPECT_MS. */
  unanswered: boolean
}

/**
 * `reached` is the state that was asked for. The other settled states are a
 * pane that can no longer get there: `gone` (closed), `exited` (its shell
 * ended), `no-agent` (nothing is there to take a turn). `pending` keeps waiting.
 */
export type WaitState = 'reached' | 'gone' | 'exited' | 'no-agent' | 'pending'

/**
 * Where one pane stands against what `lc wait --for` asked for.
 *
 * While an agent is expected, every agent state is the previous turn's and is
 * ignored: a send to a pane sitting at `waiting` must not let `--for idle`
 * return on that same `waiting` before the agent has even read the message.
 * The first real report clears the expectation (see applyStatus).
 */
export function waitState(target: LcWaitFor, v: WaitView): WaitState {
  if (!v.exists) return 'gone'
  if (v.exited) return target === 'exit' || target === 'any' ? 'reached' : 'exited'
  if (target === 'exit') return 'pending'
  if (v.unanswered) return 'no-agent'
  if (v.expecting) return 'pending'
  const s = v.status
  // No agent and none coming. `any` still has the shell's exit to wait for.
  if (s === undefined) return target === 'any' ? 'pending' : 'no-agent'
  switch (target) {
    case 'idle':
      return s === 'waiting-input' || s === 'idle' ? 'reached' : 'pending'
    case 'approval':
      return s === 'waiting-approval' ? 'reached' : 'pending'
    case 'working':
      return s === 'working' ? 'reached' : 'pending'
    case 'any':
      return s !== 'working' ? 'reached' : 'pending'
  }
}

/**
 * The keystroke that answers a permission prompt, or why there is none.
 *
 * The keys are the agent adapter's (shared/agents.ts), looked up exactly: an
 * agent whose menu nobody has read has none listed, and is refused rather than
 * guessed at — a wrong guess picks a row nobody has read, and it could be
 * "yes, and don't ask again". A pane that names no agent is a Claude pane:
 * every status this app shows today comes from Claude's hooks.
 *
 * The status is the one read at the moment of writing, not when a button was
 * drawn: a prompt answered at the keyboard a second ago is gone, and a stale
 * `1` would land in the agent's input box as a message.
 */
export function approvalKeystroke(o: {
  target: string
  agent: string | null | undefined
  status: PaneStatus | undefined
  /** Where the status came from. An estimate (`heuristic`) is never answered. */
  source?: StatusUpdate['source']
  answer: 'yes' | 'no'
}): { allow: true; data: string } | { allow: false; error: string } {
  if (o.source === 'heuristic') {
    return {
      allow: false,
      error: `${o.target}'s status is only estimated from its terminal; answer its prompts in the pane.`
    }
  }
  if (o.status !== 'waiting-approval') {
    return { allow: false, error: `${o.target} is not showing a permission prompt any more.` }
  }
  const keys = AGENTS[o.agent ?? DEFAULT_AGENT]?.approve
  if (!keys) {
    return {
      allow: false,
      error: `Light Code does not know how ${o.agent}'s permission prompt is answered; answer it in the pane.`
    }
  }
  return { allow: true, data: o.answer === 'yes' ? keys.yes : keys.no }
}

/**
 * The keystroke that stops an agent mid-turn: its adapter's (Esc for Claude
 * Code, which keeps its session), or ^C for an agent the table does not know,
 * which is what stops a program in a terminal when nothing has said otherwise.
 */
export function interruptKeystroke(agent: string | null | undefined): string {
  return AGENTS[agent ?? DEFAULT_AGENT]?.interrupt ?? '\x03'
}

/** Box drawing, block elements and the spinner glyphs a TUI redraws with. */
const DECOR = /[\u2500-\u259f\u2800-\u28ff\u00b7\u2022\u2026\u2722-\u273d\u23f5\u23f8·✻✽✢✳∗*]/g

/**
 * The line a worker card shows: the last thing on screen that says something.
 *
 * A TUI agent's last rows are furniture — the border of its input box, an empty
 * `>` prompt, a hint about shortcuts — so the card reading the bottom row
 * would show the same frame for every agent. This walks up from the bottom and
 * takes the first line that is more than that, with the frame trimmed off its
 * ends. Null when the screen has nothing to say yet.
 */
export function lastMeaningfulLine(lines: string[]): string | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const raw = lines[i]!
    const bare = raw.replace(DECOR, '').trim()
    if (bare === '' || /^[>❯$#%]$/.test(bare)) continue
    if (/^\?\s*for shortcuts/i.test(bare)) continue
    const text = raw
      .replace(/^[\s\u2500-\u257f>❯]+/, '')
      .replace(/[\s\u2500-\u257f]+$/, '')
      .replace(/\s{2,}/g, ' ')
    if (text !== '') return text.length > 160 ? `${text.slice(0, 159)}…` : text
  }
  return null
}

/** Colour, cursor and title sequences — nothing a reader of the text wants. */
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g

/** A status line an agent redraws while it works: spinner, timer, how to stop it. */
const SPINNER_LINE = /\b(?:esc|ctrl\+c) to interrupt\b/i

/**
 * A pane's screen as text somebody can read: `lc read --clean`.
 *
 * What a TUI agent draws is mostly furniture — the frame of its input box,
 * the spinner it redraws many times a second, the hint about shortcuts — and
 * an agent reading another's screen pays for every line of it. This keeps the
 * words: frame-only and spinner lines go, a frame's side bars are trimmed off
 * the lines they enclose, a line repeated by a redraw is kept once, and runs
 * of blank lines fold into one. Indentation inside a line is left alone,
 * because in a code block it is the content.
 *
 * Still the screen, not the answer — `lc result` is the answer.
 */
export function cleanLines(lines: string[]): string[] {
  const out: string[] = []
  for (const raw of lines) {
    const line = raw.replace(ANSI, '')
    const bare = line.replace(DECOR, '').trim()
    if (bare === '') {
      if (out.length > 0 && out[out.length - 1] !== '') out.push('')
      continue
    }
    if (/^[>❯$#%]$/.test(bare)) continue
    if (/^\?\s*for shortcuts/i.test(bare)) continue
    if (SPINNER_LINE.test(line)) continue
    const text = line
      .replace(/^\s*[│┃║]\s?/, '')
      .replace(/\s*[│┃║]\s*$/, '')
      .trimEnd()
    if (text.trim() === '') continue
    if (out.length > 0 && out[out.length - 1] === text) continue
    out.push(text)
  }
  while (out.length > 0 && out[out.length - 1] === '') out.pop()
  return out
}

/** Most workers one crew may have. Past this a crew is a swarm nobody can watch. */
export const MAX_CREW_WORKERS = 12
/** Spawns one caller may make in SPAWN_WINDOW_MS. */
export const SPAWN_BURST = 3
export const SPAWN_WINDOW_MS = 10_000

/**
 * Whether `lc spawn` may open another worker.
 *
 * Two limits, both against the same accident: an agent in a loop that spawns
 * on every turn. A crew stops at MAX_CREW_WORKERS, and a caller may spawn
 * SPAWN_BURST in any SPAWN_WINDOW_MS — enough to open a squad's worth at once,
 * not enough to fill the screen before anybody can look up. `recent` is the
 * caller's earlier spawns (ms); the ones outside the window are ignored.
 */
export function spawnGate(o: { recent: number[]; now: number; workers: number }): Gate {
  if (o.workers >= MAX_CREW_WORKERS) {
    return {
      allow: false,
      error:
        `This orchestra already has ${o.workers} workers, which is the most one crew may have. ` +
        'Close one (lc close @handle) before opening another.'
    }
  }
  const inWindow = o.recent.filter((t) => o.now - t < SPAWN_WINDOW_MS).sort((a, b) => a - b)
  if (inWindow.length >= SPAWN_BURST) {
    const wait = Math.max(1, Math.ceil((inWindow[0]! + SPAWN_WINDOW_MS - o.now) / 1000))
    return {
      allow: false,
      error:
        `${inWindow.length} workers were opened in the last ${SPAWN_WINDOW_MS / 1000}s. ` +
        `Try again in ${wait}s, and check whether the ones you have are doing what you meant.`
    }
  }
  return { allow: true }
}

/** Branch names `lc spawn --worktree` tries before asking for a --branch. */
export const SPAWN_BRANCH_TRIES = 5

/**
 * The branch `lc spawn --worktree` makes when no --branch is given: the
 * handle, tagged with the crew so a second orchestra in the same repository
 * does not collide with the first, and numbered after the first try because a
 * closed worker leaves its branch behind and its handle free for the next one.
 */
export function spawnBranch(handle: string, crewId: string, attempt: number): string {
  const base = `${handle}-${crewId.replace(/^c_/, '')}`
  return attempt <= 1 ? base : `${base}-${attempt}`
}

/**
 * Whether `lc approve` may answer a worker's permission prompt.
 *
 * Off unless the person has said otherwise. A permission prompt is the agent
 * asking a person; an agent answering it on that person's behalf is the very
 * thing the prompt exists to prevent — so it is allowed only to a crew's own
 * lead, only for its own workers, and only once the person has ticked "Let
 * lead approve worker tools" for that crew.
 */
export function approveGate(o: {
  from: string | undefined
  fromCrew: PaneNodeCrew | undefined
  target: string
  targetCrew: PaneNodeCrew | undefined
  settings: CrewSettings | undefined
}): Gate {
  if (o.from === undefined) {
    return { allow: false, error: 'lc approve has to know which pane is asking; run it from a pane in the app.' }
  }
  if (o.from === o.target) {
    return { allow: false, error: `${o.target} is your own pane; a permission prompt there is for a person to answer.` }
  }
  if (!o.fromCrew?.lead || o.targetCrew?.id !== o.fromCrew.id) {
    return {
      allow: false,
      error: `Only the lead of ${o.target}'s orchestra may answer its permission prompts. Leave it for the person at the screen.`
    }
  }
  if (o.settings?.leadMayApprove !== true) {
    return {
      allow: false,
      error:
        'The person has not let this orchestra\'s lead approve tools, so the prompt is theirs to answer. ' +
        'Tell them what is waiting (lc ls --crew shows who) rather than retrying.'
    }
  }
  return { allow: true }
}

/**
 * Whether an agent may act on a crew right now.
 *
 * Pausing is the person at the screen taking the baton back: while either
 * crew involved is paused, nothing an agent asks to *do* to it goes through —
 * a send, an ask, a spawn, an approve, an interrupt, a close. Looking (ls,
 * read, wait, result, events) is still allowed, so a lead can see that it is
 * paused and wait rather than guess.
 */
export function pauseGate(o: {
  fromCrew: PaneNodeCrew | undefined
  targetCrew: PaneNodeCrew | undefined
  settings: Record<string, CrewSettings>
}): Gate {
  const paused = [o.fromCrew, o.targetCrew].find((c) => c && o.settings[c.id]?.paused === true)
  if (!paused) return { allow: true }
  return {
    allow: false,
    error:
      'This orchestra is paused by the person at the screen, so nothing was done. ' +
      '`lc events` says when it is resumed.'
  }
}
