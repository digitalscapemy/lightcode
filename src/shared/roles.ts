/**
 * Squad roles: what each terminal in an orchestrated run is for.
 *
 * The distinction from fan-out is the whole design, and it is worth stating
 * before the types. Fan-out is N agents *competing* on one task, so N branches
 * is exactly right — they must not be able to reach each other's files. A squad
 * is roles *collaborating* on one task, and giving all five their own branch
 * produces five diverging branches nobody asked for and a merge nobody can do.
 *
 * So a role declares whether it writes code:
 *
 *  - `writes: true`  — developer, devops. Gets its own worktree and branch.
 *  - `writes: false` — ui-ux, security. Reads the code, writes findings as
 *    files, never edits. No branch, no worktree, no merge conflict possible.
 *  - the orchestrator sits in the repository itself on the base branch, edits
 *    nothing, and drives the others through `lc`.
 *
 * On how results come back: through files in the squad folder, never through
 * `lc read`. `lc read` returns what is *drawn on a pane's screen*, and for a
 * Claude session that is its interface, not its answer. An orchestrator that
 * screen-scrapes its team is unreliable by construction; one that waits for
 * `lc wait --for idle` and then reads a file is not. `lc ask` and `lc result`
 * since read the agent's own last message from its transcript — never its
 * screen — which is enough for a short answer; the full write-up still goes
 * in the report file, where it outlives the session.
 *
 * Deliberately importing nothing at runtime: the renderer is sandboxed with no
 * node integration, so anything shared with it has to be plain data and string
 * work, exactly as in shared/git.ts.
 */

import { AGENTS, AGENT_IDS } from './agents'
import { branchNameError } from './git'

/** Where a squad leaves its reports, relative to the squad folder. */
export const REPORTS_DIR = 'reports'

/** Filename of the per-repo override, under the repository root. */
export const ROLES_OVERRIDE = '.lightcode/roles.json'

export interface Role {
  /** Stable key. Used for the branch suffix, the report filename and `lc ls`. */
  id: string
  label: string
  /** One glyph for the pane header chip. */
  emoji: string
  /** Appended to the agent's system prompt for the life of the pane. */
  prompt: string
  /** Gets its own worktree and branch. False means it reads and reports only. */
  writes: boolean
  /** Start this role in `--permission-mode plan`. */
  plan?: boolean
  /** Exactly one role may be this, and it drives the others. */
  orchestrator?: boolean
  /**
   * The agent this role is played by when the squad dialog is not told
   * otherwise: an id from shared/agents.ts. Absent means Claude Code.
   */
  agent?: string
}

/**
 * What every role is told, regardless of which one it is.
 *
 * Kept apart from the individual prompts so the reporting contract is written
 * once: five copies of it would drift, and the orchestrator depends on all of
 * them honouring it.
 */
export const SQUAD_PREAMBLE =
  'You are one terminal in a Light Code squad working on a single task. ' +
  'Stay inside your own role: do not do another role\'s job even when you can see it needs doing' +
  'report it instead. When you finish, write your result as markdown to ' +
  '$LIGHTCODE_SQUAD_DIR/reports/<your role id>.md before you stop; that file, not your terminal ' +
  'output, is what the orchestrator reads.'

/**
 * The five that ship.
 *
 * Prompts are short on purpose. They ride in every turn's system prompt, so
 * every sentence here is paid for repeatedly, and Claude needs a job description
 * rather than a manual.
 */
export const BUILTIN_ROLES: Role[] = [
  {
    id: 'orchestrator',
    label: 'Orchestrator',
    emoji: '🎼',
    writes: false,
    orchestrator: true,
    prompt:
      'You are the orchestrator. You do not edit code yourself, you decide what needs doing, ' +
      'delegate it to the other panes, and judge what comes back. `lc ls --crew` shows your ' +
      'crew; address a member as @<handle> (quote it in PowerShell). Delegate with ' +
      '`lc ask @<handle> -` and the task on stdin (a heredoc): it waits for the turn to end and ' +
      'prints the answer. `lc spawn --role <role> "<task>"` opens another worker if you need ' +
      'one. While several work at once, follow `lc events --since <n>` rather than polling. ' +
      'For the full write-up read $LIGHTCODE_SQUAD_DIR/reports/<role>.md, never a pane\'s ' +
      'screen. A worker stuck on a permission prompt is for the person to answer: tell them ' +
      'which one, do not type into it. Give one role one task at a time; after three failed ' +
      'attempts with one worker, stop and report rather than retry. Say plainly when a report ' +
      'disagrees with another rather than quietly picking one.'
  },
  {
    id: 'developer',
    label: 'Developer',
    emoji: '⌨️',
    writes: true,
    prompt:
      'You are the developer. You own the implementation on this branch: write the code, write ' +
      'the tests, keep it building. Match the surrounding code rather than importing a style of ' +
      'your own. You are the only role that changes application logic, if design, deployment or ' +
      'security work is needed, say so in your report and leave it to the role that owns it.'
  },
  {
    id: 'ui-ux',
    label: 'UI / UX',
    emoji: '🎨',
    writes: false,
    prompt:
      'You are the UI/UX reviewer. You do not edit application code. Read the interface as it ' +
      'stands and report on layout, hierarchy, states (loading, empty, error), keyboard access, ' +
      'contrast and wording. Be concrete: name the file and the element, say what a user would ' +
      'experience, and give the change you would make. Rank what you find by what a user would ' +
      'actually notice first.'
  },
  {
    id: 'devops',
    label: 'DevOps',
    emoji: '🚢',
    writes: true,
    prompt:
      'You are the devops engineer. You own build, packaging, CI and release plumbing, not ' +
      'application logic. Keep the build reproducible and the pipeline honest about failure. ' +
      'If a change would alter what ships to users or how they get it, say so explicitly in ' +
      'your report; that is the part nobody else on the squad can see.'
  },
  {
    id: 'security',
    label: 'Security',
    emoji: '🛡️',
    writes: false,
    prompt:
      'You are the security reviewer. You do not edit code. Look for injection, path traversal, ' +
      'unsafe deserialisation, secrets in source or logs, missing authorisation, and unsafe ' +
      'defaults. For each finding give the file and line, the concrete input or state that ' +
      'triggers it, and the fix. Say clearly when you find nothing rather than padding the ' +
      'report, a fabricated finding costs the squad more than a short one.'
  }
]

/** What the app hands the renderer: the roles, plus why an override was ignored. */
export interface RolesResult {
  roles: Role[]
  /** Present when a `.lightcode/roles.json` existed but could not be used. */
  error: string | null
}

/** The role a pane holds, or null. Kept short — it goes in `lc ls` and a chip. */
export function roleById(roles: Role[], id: string | null): Role | null {
  if (!id) return null
  return roles.find((r) => r.id === id) ?? null
}

/**
 * The branch a writing role works on. Reviewing roles get none, which is the
 * point: they have nothing to merge, so they cannot conflict.
 */
export function branchForRole(task: string, role: Role): string | null {
  return role.writes ? `${task}-${role.id}` : null
}

/** Every branch a squad would create, in pane order. */
export function branchesForSquad(task: string, roles: Role[]): string[] {
  return roles.map((r) => branchForRole(task, r)).filter((b): b is string => b !== null)
}

/**
 * Why this task name cannot be used, or null.
 *
 * Checks a generated branch rather than the name itself, for the same reason
 * fan-out does: what matters is whatever git will actually be handed.
 */
export function taskNameError(task: string): string | null {
  if (task.trim() === '') return 'Give the task a name.'
  return branchNameError(`${task}-developer`)
}

/** A role id we would put in a branch name and a filename. */
export const ROLE_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/

/**
 * Why this override entry is not a role, or null.
 *
 * Says which field and why, because the reader is someone who just hand-wrote
 * a JSON file and needs to know where to look — the same reason
 * `branchNameError` returns a sentence rather than a boolean.
 */
export function roleError(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return 'Every role must be an object.'
  }
  const r = value as Record<string, unknown>
  if (typeof r.id !== 'string' || !ROLE_ID_RE.test(r.id)) {
    return 'A role id must be lowercase letters, digits and dashes (it becomes a branch name).'
  }
  if (typeof r.label !== 'string' || r.label.trim() === '') {
    return `Role "${r.id}" needs a label.`
  }
  if (typeof r.prompt !== 'string' || r.prompt.trim() === '') {
    return `Role "${r.id}" needs a prompt saying what it is for.`
  }
  if (typeof r.writes !== 'boolean') {
    return `Role "${r.id}" needs "writes": true or false, whether it gets its own branch.`
  }
  if (r.emoji !== undefined && typeof r.emoji !== 'string') {
    return `Role "${r.id}" has an emoji that is not text.`
  }
  if (r.plan !== undefined && typeof r.plan !== 'boolean') {
    return `Role "${r.id}" has a "plan" that is not true or false.`
  }
  if (r.orchestrator !== undefined && typeof r.orchestrator !== 'boolean') {
    return `Role "${r.id}" has an "orchestrator" that is not true or false.`
  }
  if (r.agent !== undefined && (typeof r.agent !== 'string' || AGENTS[r.agent] === undefined)) {
    return `Role "${r.id}" names an agent this app does not know. Known: ${AGENT_IDS.join(', ')}.`
  }
  if (r.orchestrator === true && r.writes === true) {
    return 'The orchestrator delegates rather than editing, so it cannot have "writes": true.'
  }
  return null
}

/**
 * The override applied to the built-ins, or an error naming what is wrong.
 *
 * An override *replaces* the list rather than merging into it. Merging by id
 * reads well until someone deletes a role from their file and it comes back,
 * which is the opposite of what deleting a line means.
 *
 * A file that cannot be used never half-applies: the built-ins stand and the
 * reason is reported, because a squad silently missing the role you wrote is
 * worse than one that ignored your file and said so.
 */
export function mergeRoles(builtin: Role[], override: unknown): RolesResult {
  if (override === null || override === undefined) return { roles: builtin, error: null }
  const list = Array.isArray(override)
    ? override
    : typeof override === 'object' && Array.isArray((override as { roles?: unknown }).roles)
      ? (override as { roles: unknown[] }).roles
      : null
  if (list === null) {
    return { roles: builtin, error: 'roles.json must be an array of roles, or { "roles": [...] }.' }
  }
  if (list.length === 0) {
    return { roles: builtin, error: 'roles.json lists no roles, so the built-in squad is used.' }
  }
  const seen = new Set<string>()
  const roles: Role[] = []
  for (const entry of list) {
    const problem = roleError(entry)
    if (problem !== null) return { roles: builtin, error: problem }
    const r = entry as Role
    if (seen.has(r.id)) return { roles: builtin, error: `Two roles share the id "${r.id}".` }
    seen.add(r.id)
    roles.push({
      id: r.id,
      label: r.label,
      emoji: typeof r.emoji === 'string' && r.emoji !== '' ? r.emoji : '•',
      prompt: r.prompt,
      writes: r.writes,
      plan: r.plan,
      orchestrator: r.orchestrator,
      ...(r.agent !== undefined ? { agent: r.agent } : {})
    })
  }
  const leads = roles.filter((r) => r.orchestrator === true)
  if (leads.length > 1) {
    return { roles: builtin, error: 'Only one role can be the orchestrator.' }
  }
  return { roles, error: null }
}

/**
 * The full system prompt a pane's agent carries: the shared contract, then the
 * role's own brief. Assembled in one place so main and the renderer cannot
 * disagree about what a role was told.
 */
export function rolePrompt(role: Role): string {
  return `${SQUAD_PREAMBLE}\n\nYour role is ${role.label} (id: ${role.id}). ${role.prompt}`
}
