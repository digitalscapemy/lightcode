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

/** Bumped when a field changes meaning. The CLI refuses a server it cannot read. */
export const LC_PROTOCOL = 1

/** Socket filename inside userData. Never a network port — see lcServer. */
export const LC_SOCKET_NAME = 'lc.sock'
/** Windows has no unix sockets; Node speaks named pipes under this prefix. */
export const LC_PIPE_PREFIX = '\\\\.\\pipe\\lightcode-lc-'

export type LcWaitFor = 'idle' | 'exit'

export type LcRequest =
  /**
   * Every pane in the window, with what the app already knows about each.
   *
   * `from` is the caller's own pane, taken from the environment the app puts
   * there. Without it an agent has to guess which row is itself, and a wrong
   * guess means it sends its next command to itself.
   */
  | { cmd: 'ls'; from?: string }
  /** Recent terminal output, oldest line first. */
  | { cmd: 'read'; pane: string; tail: number }
  /** Type into a pane, as though the keys had been pressed. */
  | { cmd: 'send'; pane: string; text: string; enter: boolean }
  /** Close a pane. Worktrees are left alone — removal stays a human decision. */
  | { cmd: 'close'; pane: string }
  /**
   * Block until every named pane reaches a state.
   *
   * `idle` is an agent finishing its turn — the honest signal the hooks
   * provide, not a guess about silence. `exit` is the shell itself ending,
   * which is what a plain command finishing looks like.
   */
  | { cmd: 'wait'; panes: string[]; for: LcWaitFor; timeoutMs: number }
  /** Worktree, pane, agent and prompt in one call — a fan-out from the CLI. */
  | { cmd: 'fan'; task: string; count: number; prompt: string; plan: boolean }

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
  /** This is the pane `lc` was run from — do not send yourself commands. */
  self: boolean
}

export type LcResponse =
  | { ok: true; protocol: number; panes: LcPane[] }
  | { ok: true; protocol: number; lines: string[] }
  | { ok: true; protocol: number; done: { pane: string; state: string }[] }
  | { ok: true; protocol: number; created: { pane: string; branch: string }[] }
  | { ok: true; protocol: number }
  | { ok: false; protocol: number; error: string }

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
