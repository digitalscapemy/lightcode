import type { LayoutSpec } from './layouts'
import { AGENTS, DEFAULT_AGENT, agentFor } from '../../shared/agents'
import { crewIdFor, nextHandle } from '../../shared/crew'
import { rolePrompt } from '../../shared/roles'
import type { Role } from '../../shared/roles'
import type { PaneNode } from '../../shared/types'

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
  /**
   * The agent each role is played by, by role id, where the dialog changed it.
   * A role missing here is played by its own default (roleAgent).
   */
  agents?: Record<string, string>
}

/**
 * The agent a role is played by: the dialog's choice, then the role's own
 * default from roles.json, then Claude Code. An id nobody knows counts as
 * no choice at all.
 */
export function roleAgent(role: Role, chosen?: Record<string, string>): string {
  const pick = chosen?.[role.id]
  if (pick !== undefined && AGENTS[pick]) return pick
  if (role.agent !== undefined && AGENTS[role.agent]) return role.agent
  return DEFAULT_AGENT
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
 * Stamp each pane of a fresh squad layout with what it is: its folder, its
 * role, and its place in the crew.
 *
 * `nodes` are the layout's panes in reading order and `roles` come from
 * rolesFor, so they pair up one to one and the orchestrator lands in the large
 * first slot. The orchestrator leads the crew; every handle is the role id, so
 * the lead addresses `@developer` by the name it was told the role has.
 *
 * The crew id comes from the squad folder (crewIdFor), the same id a squad
 * opened before crews existed is given when it is adopted on restore — one
 * squad, one crew, whichever way it arrived. `crewId` overrides it for the one
 * case where that would merge two crews: the same task opened twice while the
 * first squad is still on screen, both pointing at one folder.
 *
 * A writing role works in its own worktree; everyone else sits in the
 * repository, since a reviewer's checkout of its own would be a copy nobody
 * edits. A pane whose role is played by another agent than Claude records it
 * (roleAgent).
 * Mutates the nodes; returns the ones it stamped, paired with roles.
 */
export function squadNodes(
  nodes: PaneNode[],
  roles: Role[],
  o: {
    cwd: string
    squadDir: string
    worktreeFor: Map<string, string>
    crewId?: string
    agents?: Record<string, string>
  }
): { node: PaneNode; role: Role }[] {
  const crewId = o.crewId ?? crewIdFor(o.squadDir)
  const taken: string[] = []
  const out: { node: PaneNode; role: Role }[] = []
  roles.forEach((role, i) => {
    const node = nodes[i]
    if (!node) return
    node.cwd = o.worktreeFor.get(role.id) ?? o.cwd
    node.role = { id: role.id, squadDir: o.squadDir }
    const handle = nextHandle(role.id, taken, role.orchestrator === true)
    taken.push(handle)
    node.crew = { id: crewId, handle, ...(role.orchestrator === true ? { lead: true as const } : {}) }
    // Claude is what a pane that names no agent runs, so a squad played by
    // Claude alone is stamped exactly as it was before agents could be picked.
    const agent = roleAgent(role, o.agents)
    if (agent !== DEFAULT_AGENT) node.agent = agent
    out.push({ node, role })
  })
  return out
}

/**
 * What each pane is told to run.
 *
 * Every pane starts an agent, but only the orchestrator is given the brief:
 * the others are started empty and wait to be delegated to. That is the whole
 * shape of the thing — five agents each independently attacking the same brief
 * is a fan-out, and there is already a button for that.
 *
 * For Claude the role's own instructions do not appear here at all. They ride in
 * the pane's environment and are re-applied by the `claude` wrapper at every
 * launch, so a role survives the agent restarting itself. See SpawnOptions.role.
 * An agent with no wrapper is told its role in its first message instead, and
 * a worker of that kind starts on the role alone. A shell is typed nothing:
 * the empty string.
 */
export function commandFor(
  role: Role,
  prompt: string,
  quoted: (p: string) => string,
  agent: string = roleAgent(role)
): string {
  const adapter = agentFor(agent)
  return adapter.launch(role.orchestrator === true ? prompt : null, {
    plan: role.plan === true,
    quote: quoted,
    rolePrompt: adapter.rolePromptVia === 'first-message' ? rolePrompt(role) : null
  })
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
