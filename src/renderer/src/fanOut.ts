import { branchNameError } from '../../shared/git'

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

/** More than four rarely helps and always costs four times the tokens. */
export const AGENT_COUNTS = [2, 3, 4] as const
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

/** The grid these agents go in. Two abreast, four in a square. */
export function layoutIdFor(count: AgentCount): string {
  return count === 2 ? '2-cols' : count === 3 ? '3-cols' : '4-grid'
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
  return isWindows ? `'${flat.replace(/'/g, "''")}'` : `'${flat.replace(/'/g, "'\\''")}'`
}

/**
 * The command each pane runs.
 *
 * The prompt rides in as an argument rather than being typed after Claude opens.
 * Typing it would mean guessing when Claude is ready to receive it, and guessing
 * at readiness is exactly the class of bug this app keeps having to remove.
 */
export function agentCommand(prompt: string, isWindows: boolean): string {
  return `claude ${quotePrompt(prompt, isWindows)}`
}

/** What a fan-out was asked to do. */
export interface FanOutRequest {
  task: string
  count: AgentCount
  prompt: string
}
