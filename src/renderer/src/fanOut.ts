import { AGENTS } from '../../shared/agents'
import { branchNameError } from '../../shared/git'
import { psNativeArgSafe, psSingleQuote } from '../../shared/psQuote'

/**
 * Fan one task across several agents, each in its own worktree.
 *
 * The move this app exists for. One prompt, four Claudes, four checkouts of the
 * same repository — they cannot overwrite each other, so you can leave and come
 * back to four independent answers and keep whichever is best.
 *
 * Everything after that is `git`: read the branches, merge the one you want.
 * There is no comparison view here for the same reason there is no diff viewer
 * anywhere else in this app.
 */

/**
 * Each of these has a real grid in LAYOUT_PRESETS, so nobody ends up with more
 * agents than panes. They climb steeply on purpose: the cost climbs with them,
 * and sixteen agents is a decision, not the next notch after eight.
 */
export const AGENT_COUNTS = [2, 3, 4, 6, 8, 16] as const
export type AgentCount = (typeof AGENT_COUNTS)[number]

/** One branch per agent, numbered so the panes read left to right. */
export function branchNamesFor(task: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => `${task}-${i + 1}`)
}

/**
 * Why this task name cannot be used, or null. Checks the generated branch rather
 * than the name itself: `x.lock` is fine as a task, `x.lock-1` is fine as a ref,
 * but the rule that matters is whatever git will be handed.
 */
export function taskNameError(task: string): string | null {
  if (task.trim() === '') return 'Give the task a name.'
  return branchNameError(`${task}-1`)
}

/** The grid these agents go in — one entry per count, checked by its test. */
const GRIDS: Record<AgentCount, string> = {
  2: '2-cols',
  3: '3-cols',
  4: '4-grid',
  6: '6-grid',
  8: '8-grid',
  16: '16-grid'
}

export function layoutIdFor(count: AgentCount): string {
  return GRIDS[count]
}

/**
 * A prompt as a single shell argument.
 *
 * Not paths.ts's shellArg: that one rejects a double quote outright, because in
 * a *path* a quote means something is spoofing one. In a prompt it is ordinary
 * punctuation and has to survive. PowerShell escapes a single quote by doubling
 * it; POSIX shells end the quoted run and splice one in.
 */
export function quotePrompt(prompt: string, isWindows: boolean): string {
  // A newline would submit the command line early, splitting the prompt in two.
  const flat = prompt.replace(/[\r\n]+/g, ' ').trim()
  // PowerShell: psSingleQuote also escapes the curly quotes it treats as ',
  // and psNativeArgSafe stops 5.1 from splitting the prompt into extra
  // arguments when it hands it to the agent binary.
  return isWindows
    ? psSingleQuote(psNativeArgSafe(flat))
    : `'${flat.replace(/'/g, "'\\''")}'`
}

/**
 * The command each pane runs.
 *
 * The prompt rides in as an argument rather than being typed after Claude opens.
 * Typing it would mean guessing when Claude is ready to receive it, and guessing
 * at readiness is exactly the class of bug this app keeps having to remove.
 *
 * `plan` starts every agent in plan mode, which is often the better way to fan
 * something out: three agents rewriting the code is expensive and awkward to
 * compare, where three agents each proposing an approach is cheap, touches no
 * files, and reads side by side. Pick the approach, then run it once.
 */
export function agentCommand(prompt: string, isWindows: boolean, plan = false): string {
  return AGENTS.claude!.launch(prompt, { plan, quote: (p) => quotePrompt(p, isWindows) })
}

/** What a fan-out was asked to do. */
export interface FanOutRequest {
  task: string
  count: AgentCount
  prompt: string
  /** Start every agent in plan mode — proposals to compare, not edits. */
  plan: boolean
}
