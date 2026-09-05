import type { LayoutSpec } from './layouts'
import type { Role } from '../../shared/roles'

/**
 * Shaping a squad: who gets a worktree, and where the panes go.
 *
 * Pure, so the rules that decide what a squad costs — how many branches, how
 * many panes, which one is in charge — can be checked without a repository or
 * a DOM. The DOM half lives in squadUi.ts, exactly as fanOut.ts and fanOutUi.ts
 * divide.
 */

/** What a squad was asked to do. */
export interface SquadRequest {
  task: string
  /** Roles to open, in the order they were offered. */
  roleIds: string[]
  /** The brief. Goes to the orchestrator; it decides who does what. */
  prompt: string
}

/**
 * The roles a request names, in a fixed order: orchestrator first, then the
 * rest as defined.
 *
 * Order is not cosmetic. It decides which pane lands in the large slot, and the
 * orchestrator has to be that one — it is the pane a person actually talks to,
 * and the one whose output is prose rather than a build log.
 */
export function rolesFor(all: Role[], roleIds: string[]): Role[] {
  const chosen = all.filter((r) => roleIds.includes(r.id))
  const lead = chosen.filter((r) => r.orchestrator === true)
  const rest = chosen.filter((r) => r.orchestrator !== true)
  return [...lead, ...rest]
}

/**
 * The layout: the orchestrator large on the left, the workers beside it.
 *
 * Built rather than picked from LAYOUT_PRESETS because the count is not ours to
 * choose — a repository's roles.json may define three roles or nine, and a
 * preset table would have to guess at every number. The presets stay what they
 * are for: shapes a person picks deliberately.
 *
 * Workers stack in one column up to four, then split into two, which is where
 * a single column stops being readable at ordinary window heights.
 */
export function squadLayoutSpec(workerCount: number): LayoutSpec {
  if (workerCount <= 0) return 'p'
  const workers: LayoutSpec[] = Array.from({ length: workerCount }, () => 'p' as LayoutSpec)
  if (workerCount <= 4) return { row: ['p', { col: workers }] }
  const half = Math.ceil(workerCount / 2)
  return {
    row: ['p', { row: [{ col: workers.slice(0, half) }, { col: workers.slice(half) }] }]
  }
}

/**
 * What each pane is told to run.
 *
 * Every pane starts an agent, but only the orchestrator is given the brief:
 * the others are started empty and wait to be delegated to. That is the whole
 * shape of the thing — five agents each independently attacking the same brief
 * is a fan-out, and there is already a button for that.
 *
 * The role's own instructions do not appear here at all. They ride in the pane's
 * environment and are re-applied by the `claude` wrapper at every launch, so a
 * role survives the agent restarting itself. See SpawnOptions.role.
 */
export function commandFor(role: Role, prompt: string, quoted: (p: string) => string): string {
  const plan = role.plan === true ? '--permission-mode plan ' : ''
  return role.orchestrator === true
    ? `claude ${plan}${quoted(prompt)}`
    : `claude ${plan}`.trimEnd()
}

/**
 * A one-line account of what pressing the button will do, before it is pressed.
 *
 * Branches are the part worth stating plainly: they are the only thing a squad
 * leaves behind that outlives its panes, and "three branches" is a different
 * decision from "five terminals".
 */
export function squadCost(task: string, roles: Role[]): string {
  const writers = roles.filter((r) => r.writes)
  const readers = roles.filter((r) => !r.writes && r.orchestrator !== true)
  const parts = [`${roles.length} panes`]
  parts.push(
    writers.length === 0
      ? 'no new branches'
      : `${writers.length} branch${writers.length === 1 ? '' : 'es'} (${writers
          .map((r) => `${task}-${r.id}`)
          .join(', ')})`
  )
  if (readers.length > 0) {
    parts.push(`${readers.length} reviewing, which write reports rather than code`)
  }
  return parts.join(' · ')
}
