import type { CrewEvent } from './crew'

/**
 * The `lc` wire protocol: what the CLI may ask the app, and what it gets back.
 *
 * One line of JSON in, one line of JSON out, over a socket the app owns. The
 * CLI is a thin client with no knowledge of its own — every answer here is
 * something the app is already tracking for the badges and the status dots.
 *
 * Shared by all three layers so the client, the server and the renderer cannot
 * drift about what a request looks like.
 */

/**
 * Bumped when a field changes meaning. The CLI refuses a server it cannot read.
 *
 * 3: every request carries the caller's token, errors say what kind of no they
 * are (and so which exit code), and a reply may carry a warning.
 */
export const LC_PROTOCOL = 3

/**
 * Every command the app answers. The one list: parseRequest checks against it
 * and the request union below is keyed by it, so the two cannot disagree about
 * what exists the way the hand-copied list in the server once could.
 */
export const LC_COMMANDS = [
  'ls',
  'read',
  'send',
  'close',
  'wait',
  'fan',
  'spawn',
  'ask',
  'result',
  'events',
  'approve',
  'interrupt'
] as const
export type LcCommand = (typeof LC_COMMANDS)[number]

/**
 * How a refusal is told apart from a broken pipe, which is what an agent
 * branching on `$?` actually needs. 1 is everything that never reached a
 * decision; 2 is a request the app could not make sense of; 3 is the app
 * understanding perfectly and saying no; 4 is a wait that ran out of time.
 */
export type LcErrorKind = 'transport' | 'usage' | 'refused' | 'timeout'
export const LC_EXIT: Record<'ok' | LcErrorKind, number> = {
  ok: 0,
  transport: 1,
  usage: 2,
  refused: 3,
  timeout: 4
}

/** Where `lc spawn --split` may put a worker, overriding the app's choice. */
export const LC_SPLIT = ['right', 'down'] as const
export type LcSplit = (typeof LC_SPLIT)[number]

/**
 * Socket filename inside userData: `lc-<pid>.sock`, one per running instance.
 * Never a network port. The pid is not decoration — see socketPath in lcServer.
 */
export const LC_SOCKET_PREFIX = 'lc-'
export const LC_SOCKET_SUFFIX = '.sock'
/** Windows has no unix sockets; Node speaks named pipes under this prefix. */
export const LC_PIPE_PREFIX = '\\\\.\\pipe\\lightcode-lc-'

/**
 * What `lc wait` can wait for. `idle` is a turn ending, `approval` a permission
 * prompt appearing, `working` a turn starting, `exit` the shell ending, and
 * `any` whichever of idle, approval or exit comes first — "tell me when this
 * pane wants something from somebody".
 */
export const LC_WAIT_FOR = ['idle', 'exit', 'approval', 'working', 'any'] as const
export type LcWaitFor = (typeof LC_WAIT_FOR)[number]

/**
 * Who is asking, carried on every request.
 *
 * `token` is the secret the app put in the caller's pane environment; main
 * swaps it for the pane it was issued to and deletes it before the request
 * goes any further, so the renderer only ever sees `from`. Without a token the
 * client's own `from` is kept but marked `unverified` — an old client, or a
 * command run from somewhere the app never spawned, still works, and whatever
 * acts on the answer can tell it was a claim rather than a fact.
 */
export interface LcCaller {
  from?: string
  token?: string
  unverified?: true
}

/**
 * Wherever a request names a pane, it may name it by crew instead: `@lead`,
 * `@*` (the rest of your crew), or `@<handle>` (a member's handle, or failing
 * that its role). The renderer resolves these against the caller's crew before
 * anything else looks at the request. See shared/crew.resolveTarget.
 */
export type LcRequest = LcCaller & (
  /**
   * Every pane in the window, with what the app already knows about each.
   *
   * `from` is the caller's own pane, taken from the environment the app puts
   * there. Without it an agent has to guess which row is itself, and a wrong
   * guess means it sends its next command to itself.
   */
  | {
      cmd: 'ls'
      /**
       * Only the caller's own crew — or, from a pane in no crew, every pane that
       * is in one. What a lead asks when it wants to know who it is directing.
       */
      crew?: boolean
    }
  /**
   * Recent terminal output, oldest line first. `clean` drops what a TUI draws
   * around its words — frames, spinners, redraws — see lcPolicy.cleanLines.
   */
  | { cmd: 'read'; pane: string; tail: number; clean?: boolean }
  /**
   * Type into a pane, as though the keys had been pressed.
   *
   * `force` is the one way past the guard on a pane showing a permission
   * prompt, where the keystrokes would answer the prompt instead of reaching
   * the agent.
   */
  | { cmd: 'send'; pane: string; text: string; enter: boolean; force?: boolean }
  /** Close a pane. Worktrees are left alone — removal stays a human decision. */
  | { cmd: 'close'; pane: string }
  /**
   * Block until every named pane reaches a state.
   *
   * `idle` is an agent finishing its turn — the honest signal the hooks
   * provide, not a guess about silence. `exit` is the shell itself ending,
   * which is what a plain command finishing looks like.
   *
   * A pane that can no longer get there settles at once rather than holding
   * the line for the whole timeout: `gone` when it was closed, `exited` when
   * its shell ended, `no-agent` when a sent message was never picked up.
   */
  | { cmd: 'wait'; panes: string[]; for: LcWaitFor; timeoutMs: number }
  /**
   * Worktree, pane, agent and prompt in one call — a fan-out from the CLI.
   *
   * `from` is the caller's own pane, and it decides which repository is branched
   * from. Without it the app fell back to whichever pane the human last clicked,
   * so an agent fanning out while its user was looking at another project
   * created worktrees and launched agents in the wrong repository entirely.
   */
  | { cmd: 'fan'; task: string; count: number; prompt: string; plan: boolean }
  /**
   * Open a worker in the caller's orchestra, beside it, without taking the
   * keyboard from whoever is typing. A caller in no orchestra becomes the lead
   * of a new one, and the reply says so.
   *
   * `agent` is an id from shared/agents.ts (Claude when absent); `role` a squad
   * role id; `handle` what the crew will call it. `worktree` puts it on a new
   * branch of its own, named `branch` or after its handle. A null prompt
   * starts the agent empty.
   */
  | {
      cmd: 'spawn'
      agent?: string
      role?: string
      handle?: string
      cwd?: string
      worktree?: boolean
      branch?: string
      plan: boolean
      split?: LcSplit
      prompt: string | null
    }
  /**
   * Send, wait for the turn to end, and return the answer — one call for the
   * loop an orchestrator otherwise writes by hand. A pane mid-turn is let
   * finish first, so the answer is to this question and not the one before.
   */
  | { cmd: 'ask'; pane: string; text: string; timeoutMs: number }
  /**
   * The pane's last answer: the agent's final message from its transcript, or
   * failing that its screen, cleaned.
   */
  | { cmd: 'result'; pane: string }
  /**
   * What has happened in the caller's crew since `since`, held open until
   * something does or `timeoutMs` passes. Without `since`, what is there now.
   */
  | { cmd: 'events'; since?: number; timeoutMs: number }
  /**
   * Answer a worker's permission prompt. Refused unless the person has let
   * this crew's lead approve; see lcPolicy.approveGate.
   */
  | { cmd: 'approve'; pane: string; answer: 'yes' | 'no' }
  /** Stop the turn a pane's agent is in the middle of. The session keeps running. */
  | { cmd: 'interrupt'; pane: string }
)

/** One pane, as `lc ls` reports it. */
export interface LcPane {
  pane: string
  tab: string
  /** working | waiting | approval | idle — the same states the dot shows. */
  status: string
  /** Tool the agent is running, when it is running one. */
  tool: string | null
  contextTokens: number
  contextWindow: number
  cwd: string
  branch: string | null
  /** True when this pane sits in a linked worktree rather than the repo. */
  worktree: boolean
  /**
   * Squad role this pane holds, or null for an ordinary terminal.
   *
   * The orchestrator's whole job is deciding who to give a piece of work to,
   * and without this it would have to infer that from branch names — which are
   * a convention it cannot verify and a plain pane does not follow at all.
   */
  role: string | null
  /** This is the pane `lc` was run from — do not send yourself commands. */
  self: boolean
  /**
   * The crew fields, present only on a pane that is in an orchestra or was
   * opened for a named agent. Absent rather than null so that a window not
   * using either answers `lc ls --json` exactly as it did before they existed.
   */
  crew?: string
  /** Address it as `@handle`. */
  handle?: string
  /** This pane conducts its crew. */
  lead?: true
  agent?: string
  /**
   * `heuristic` when the status is a guess from the agent's terminal going
   * quiet (an agent with no hooks); absent when it is Claude's own word.
   */
  statusSource?: 'heuristic'
}

/** A worker `lc spawn` opened. */
export interface LcSpawned {
  pane: string
  handle: string
  crew: string
  cwd: string
  agent: string
  /** The branch it is on, when --worktree made it one. */
  branch?: string
}

/** A pane's last answer, and where it came from. */
export interface LcResult {
  pane: string
  text: string
  /** `transcript`: the agent's own final message. `screen`: what it drew, cleaned. */
  source: 'transcript' | 'screen'
}

/**
 * A reply. A success may carry a `warning`, which the client prints to stderr
 * and does not let change the exit code: the thing was done, and somebody
 * should know something about it. A failure says what kind of failure it was.
 */
export type LcResponse =
  | ({ ok: true; protocol: number; warning?: string } & (
      | { panes: LcPane[] }
      | { lines: string[] }
      | { done: { pane: string; state: string }[] }
      | { created: { pane: string; branch: string }[] }
      | { spawned: LcSpawned }
      | { result: LcResult }
      | { events: CrewEvent[]; seq: number }
      | Record<never, never>
    ))
  | { ok: false; protocol: number; error: string; kind?: LcErrorKind }

/**
 * Why a request was refused, in words meant for whoever typed it — which is
 * usually an agent reading stdout, so they have to be unambiguous rather than
 * merely polite.
 */
export const LC_OFF_MESSAGE =
  'The agent CLI is switched off. Turn it on in Mission Control to let agents drive panes.'

/**
 * What an agent is told about `lc`, appended to its system prompt.
 *
 * One sentence, pointing at `--help` rather than listing the commands. The full
 * surface changes; a pointer does not, and an agent that needs the detail can
 * fetch it in one call. Injecting the whole table into every session would cost
 * tokens on every turn to teach something most sessions never use.
 *
 * The rule about not driving your own pane is here rather than in --help because
 * it is the one mistake that is expensive: a pane that sends itself a command
 * interrupts the very turn that sent it.
 */
export const LC_SYSTEM_HINT =
  'You are running inside a Light Code pane. The `lc` command lists and drives ' +
  'the other panes in this window — run `lc --help` to see what it does. ' +
  'Never send commands to your own pane; `lc ls` marks it with an asterisk.'
