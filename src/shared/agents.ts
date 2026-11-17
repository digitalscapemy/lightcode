/**
 * Agents: what it takes to start one in a pane, and to answer and stop it.
 *
 * One entry per agent the app knows how to drive, as plain data and string
 * work — the renderer is sandboxed, so anything shared with it has to be.
 * Everything that differs between agents lives here and nowhere else: how its
 * command line is built, which keys answer its permission prompt, which key
 * stops a turn. A caller asks the table rather than growing an `if claude`.
 *
 * Claude Code is the one agent whose status the app reads exactly (its hooks),
 * and the one whose prompt keys have been looked at. Codex and Gemini are
 * started, stopped and watched — their status is a guess from the terminal
 * (main/quietStatus.ts, shown as ≈) — but never approved for: nobody has read
 * their menus. A plain shell is listed too, so a picker can open a worker that
 * runs nothing at all.
 */

export interface AgentLaunchOptions {
  /** Start in a mode that proposes rather than edits. */
  plan: boolean
  /** One prompt as one shell argument, for the pane's shell. See fanOut.quotePrompt. */
  quote: (prompt: string) => string
  /**
   * The squad role's full prompt (roles.rolePrompt), for an agent that takes it
   * as its first message. Ignored by one whose wrapper applies it (Claude).
   */
  rolePrompt?: string | null
}

export interface AgentAdapter {
  id: string
  label: string
  /** The executable the launch line starts with. */
  bin: string
  /**
   * The command typed at the pane's first prompt. A null prompt starts the
   * agent empty, waiting to be told what to do. An empty string types nothing:
   * the pane is left at its shell.
   */
  launch(prompt: string | null, o: AgentLaunchOptions): string
  /**
   * How the app learns what the agent is doing: its own hooks, a guess from
   * the terminal going quiet, or not at all (a shell has no turns).
   */
  status: 'hooks' | 'heuristic' | 'none'
  /**
   * How a squad role reaches it: the generated wrapper re-applies it at every
   * launch, or it has to ride in front of the first message.
   */
  rolePromptVia: 'wrapper' | 'first-message'
  /** The key that stops the turn it is in the middle of. */
  interrupt: string
  /**
   * The keys that answer its permission prompt. Absent means nobody has read
   * that menu, and approving through the app is refused rather than guessed:
   * a wrong guess picks some row nobody has read, and it could be "yes, and
   * don't ask again".
   */
  approve?: { yes: string; no: string }
  /**
   * Written from the agent's documentation and never run here. Shown beside it
   * in a picker, so nobody mistakes it for a path somebody has walked.
   */
  untested?: true
}

/**
 * The prompt an agent without the wrapper is started on: the role first, then
 * the task. With a role and no task, the role alone — the agent takes it as a
 * turn and then waits, which is the closest it can come to a system prompt.
 * Null when there is neither.
 */
export function firstMessage(prompt: string | null, rolePrompt: string | null | undefined): string | null {
  if (!rolePrompt) return prompt
  if (prompt === null) return `${rolePrompt}\n\nWait for your first task.`
  return `${rolePrompt}\n\nYour task: ${prompt}`
}

/**
 * Claude Code. The launch line is exactly what fan-out and the squad have
 * always typed; they build it through here now, so the two cannot drift.
 *
 * Its permission menu numbers its rows (1 is "Yes") and takes Esc as "No, and
 * tell Claude what to do differently". Esc also stops a turn without ending
 * the session.
 */
const claude: AgentAdapter = {
  id: 'claude',
  label: 'Claude Code',
  bin: 'claude',
  launch(prompt, o) {
    const mode = o.plan ? '--permission-mode plan ' : ''
    return prompt === null ? `claude ${mode}`.trimEnd() : `claude ${mode}${o.quote(prompt)}`
  },
  status: 'hooks',
  rolePromptVia: 'wrapper',
  interrupt: '\x1b',
  approve: { yes: '1', no: '\x1b' }
}

/**
 * OpenAI's Codex CLI (checked against codex-cli 0.139): `codex [PROMPT]` opens
 * its TUI on that prompt. Plan mode is its read-only sandbox; either way it
 * asks before acting (`-a on-request`), so its prompts reach the person.
 *
 * Its menu keys have not been read, so it has no `approve`. ^C stops a turn.
 */
const codex: AgentAdapter = {
  id: 'codex',
  label: 'Codex',
  bin: 'codex',
  launch(prompt, o) {
    const mode = o.plan ? '-s read-only -a on-request' : '-a on-request'
    const first = firstMessage(prompt, o.rolePrompt)
    return first === null ? `codex ${mode}` : `codex ${mode} ${o.quote(first)}`
  },
  status: 'heuristic',
  rolePromptVia: 'first-message',
  interrupt: '\x03'
}

/**
 * Google's Gemini CLI, written from its documentation only — it was not
 * installed where this was written, hence `untested`. `-i` opens the
 * interactive session on a prompt (a bare prompt would answer once and exit);
 * `--approval-mode plan` is its read-only mode.
 */
const gemini: AgentAdapter = {
  id: 'gemini',
  label: 'Gemini',
  bin: 'gemini',
  launch(prompt, o) {
    const mode = o.plan ? ' --approval-mode plan' : ''
    const first = firstMessage(prompt, o.rolePrompt)
    return first === null ? `gemini${mode}` : `gemini${mode} -i ${o.quote(first)}`
  },
  status: 'heuristic',
  rolePromptVia: 'first-message',
  interrupt: '\x03',
  untested: true
}

/**
 * A plain shell: a worker that runs nothing until somebody types into it. No
 * status, because a shell has no turns to report, and nothing to launch.
 */
const shell: AgentAdapter = {
  id: 'shell',
  label: 'Shell',
  bin: '',
  launch: () => '',
  status: 'none',
  rolePromptVia: 'first-message',
  interrupt: '\x03'
}

/**
 * Every agent the app can start, by id.
 *
 * Without a prototype, because the id is typed by an agent down a socket: on a
 * plain object `--agent constructor` would find Object and sail past every
 * "unknown agent" check.
 */
export const AGENTS: Readonly<Record<string, AgentAdapter>> = Object.freeze(
  Object.assign(Object.create(null) as Record<string, AgentAdapter>, { claude, codex, gemini, shell })
)

/** The ids, for a usage message or a picker. */
export const AGENT_IDS: readonly string[] = Object.keys(AGENTS)

/** The default agent: what a pane that names none is running, if anything. */
export const DEFAULT_AGENT = 'claude'

/**
 * The adapter for an id, falling back to Claude for an id nobody knows — a
 * state file from a later version may name one, and a pane that names none is
 * a Claude pane as far as anything here can tell.
 *
 * For anything that types an answer into a prompt, use AGENTS[id] directly
 * instead: falling back there would be guessing at a menu.
 */
export function agentFor(id: string | null | undefined): AgentAdapter {
  return (id ? AGENTS[id] : undefined) ?? AGENTS[DEFAULT_AGENT]!
}
