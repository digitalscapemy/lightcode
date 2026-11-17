import { createTab } from './app'
import { alertDialog } from './confirmDialog'
import { quotePrompt } from './fanOut'
import { createWorktreesSerially } from './fanOutUi'
import { buildLayout } from './layouts'
import { agentOptions } from './agentPicker'
import { commandFor, roleAgent, rolesFor, squadCost, squadLayoutSpec, squadNodes } from './squad'
import type { SquadRequest } from './squad'
import { paneNodes } from './splitTree'
import { expectingAgent, newId, pendingCommand, state } from './store'
import { crewIdFor } from '../../shared/crew'
import { branchForRole, taskNameError } from '../../shared/roles'
import type { Role } from '../../shared/roles'
import type { LayoutNode } from '../../shared/types'
import { toast } from './ui/toast'

/**
 * Opening a squad: one orchestrator and a set of specialists, each in its own
 * terminal, on one task.
 *
 * The sibling of fan-out and the opposite of it. Fan-out is several agents
 * competing on the same brief, kept apart by a branch each. A squad is several
 * agents doing *different* jobs on one brief, so only the ones that write code
 * need a branch, and the rest read and report. See shared/roles.ts.
 */

/**
 * Create the shared folder, the branches, and a tab of panes holding the squad.
 *
 * Order matters: the squad folder first, because every pane's environment names
 * it and a pane that spawned before it existed would be pointed at nothing.
 */
export async function runSquad(
  cwd: string,
  roles: Role[],
  req: SquadRequest
): Promise<{ pane: string; role: string }[] | null> {
  const chosen = rolesFor(roles, req.roleIds)
  if (chosen.length === 0) return null

  const squadDir = await window.lightclaude.git.prepareSquad(cwd, req.task)
  if (squadDir === null) {
    await alertDialog('Could not create the squad folder beside the repository.')
    return null
  }

  const writers = chosen.filter((r) => r.writes)
  const branches = writers
    .map((r) => branchForRole(req.task, r))
    .filter((b): b is string => b !== null)
  const created = await createWorktreesSerially(cwd, branches)
  if (created === null) return null // it has already said why, and cleaned up

  const layout: LayoutNode = buildLayout(squadLayoutSpec(chosen.length - 1), () => newId('p'))
  const nodes = paneNodes(layout)
  // buildLayout fills in reading order and squadLayoutSpec puts the large slot
  // first, so node 0 is the orchestrator — the same order rolesFor guarantees.
  const isWindows = window.lightclaude.platform === 'win32'
  const worktreeFor = new Map<string, string>()
  writers.forEach((role, i) => {
    const path = created[i]
    if (path !== undefined) worktreeFor.set(role.id, path)
  })

  // A squad for this task may still be open from before, with the same folder
  // and so the same crew id; the new one gets its own rather than joining it.
  const inUse = state.tabs.some((t) =>
    paneNodes(t.layout).some((n) => n.crew?.id === crewIdFor(squadDir))
  )
  const stamped = squadNodes(nodes, chosen, {
    cwd,
    squadDir,
    worktreeFor,
    ...(inUse ? { crewId: newId('c') } : {}),
    ...(req.agents ? { agents: req.agents } : {})
  })
  for (const { node, role } of stamped) {
    // The same choice squadNodes stamped, asked again rather than read back off
    // node.agent: Claude is never stamped, and an absent agent would let
    // commandFor fall back to whatever roles.json names for the role.
    const agent = roleAgent(role, req.agents)
    const command = commandFor(role, req.prompt, (p) => quotePrompt(p, isWindows), agent)
    // A role played by a plain shell starts nothing, and nothing is coming.
    if (command === '') continue
    pendingCommand.set(node.id, command)
    // Record that an agent is coming, so an `lc wait` issued straight after this
    // returns holds the line rather than refusing a pane with nothing in it yet.
    expectingAgent.add(node.id)
  }

  await createTab({ projectPath: cwd, name: req.task, layout, awaitSpawn: true })

  return chosen
    .map((role, i) => ({ pane: nodes[i]?.id ?? '', role: role.id }))
    .filter((r) => r.pane !== '')
}

// ---------- The dialog ----------

function askSquad(roles: Role[], available: Record<string, boolean>): Promise<SquadRequest | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div')
    overlay.id = 'shortcuts-overlay'
    const modal = document.createElement('div')
    modal.className = 'shortcuts-modal confirm-modal fanout-modal'

    const body = document.createElement('div')
    body.className = 'shortcuts-body confirm-text'

    const taskLabel = document.createElement('div')
    taskLabel.textContent = 'Task name — the branches and the squad folder take their name from it'
    const task = document.createElement('input')
    task.className = 'prompt-input'
    task.placeholder = 'auth-refactor'
    task.spellcheck = false

    const rolesLabel = document.createElement('div')
    rolesLabel.className = 'fanout-label'
    rolesLabel.textContent = 'Roles'
    const roleList = document.createElement('div')
    roleList.className = 'squad-roles'

    // Every role is on by default: the squad is the point, and a user who wants
    // fewer can say so faster than one who has to assemble it from nothing.
    const picked = new Set(roles.map((r) => r.id))
    // Only the roles whose agent was changed here; the rest keep their own.
    const agents: Record<string, string> = {}
    for (const role of roles) {
      const row = document.createElement('label')
      row.className = 'squad-role'
      const box = document.createElement('input')
      box.type = 'checkbox'
      box.checked = true
      // The orchestrator is what makes this a squad rather than a grid of
      // terminals, so it is not a choice — leaving it out has no meaning.
      box.disabled = role.orchestrator === true
      box.addEventListener('change', () => {
        if (box.checked) picked.add(role.id)
        else picked.delete(role.id)
        revalidate()
      })
      const text = document.createElement('span')
      text.textContent = `${role.emoji} ${role.label}`
      const note = document.createElement('span')
      note.className = 'squad-role-note'
      note.textContent = role.orchestrator
        ? 'directs the others'
        : role.writes
          ? 'own branch'
          : 'reads and reports'
      // Which agent plays it. Claude unless the role or the person says else;
      // one whose command was not found on PATH is dimmed and says so, but can
      // still be picked — the pane's shell may well find it.
      const agent = document.createElement('select')
      agent.className = 'squad-agent'
      agent.title = 'The agent that plays this role'
      for (const o of agentOptions(available)) {
        const opt = document.createElement('option')
        opt.value = o.id
        opt.textContent = o.label
        opt.title = o.note ?? ''
        if (o.note !== null) opt.className = 'agent-missing'
        agent.appendChild(opt)
      }
      agent.value = roleAgent(role)
      agent.addEventListener('change', () => {
        if (agent.value === roleAgent(role)) delete agents[role.id]
        else agents[role.id] = agent.value
      })
      row.append(box, text, note, agent)
      roleList.appendChild(row)
    }

    const promptLabel = document.createElement('div')
    promptLabel.className = 'fanout-label'
    promptLabel.textContent = 'Brief — goes to the orchestrator, which delegates it'
    const prompt = document.createElement('textarea')
    prompt.className = 'prompt-input fanout-prompt'
    prompt.rows = 3
    prompt.placeholder = 'Add rate limiting to the public API, then have it reviewed'
    prompt.spellcheck = false

    const cost = document.createElement('div')
    cost.className = 'fanout-cost'
    const hint = document.createElement('div')
    hint.className = 'prompt-hint'
    body.append(taskLabel, task, rolesLabel, roleList, promptLabel, prompt, cost, hint)

    const footer = document.createElement('div')
    footer.className = 'shortcuts-footer confirm-actions'
    const cancel = document.createElement('button')
    cancel.className = 'shortcuts-secondary'
    cancel.textContent = 'Cancel'
    const accept = document.createElement('button')
    accept.className = 'shortcuts-primary'
    footer.append(cancel, accept)
    modal.append(body, footer)
    overlay.appendChild(modal)

    let settled = false
    const finish = (answer: SquadRequest | null): void => {
      if (settled) return
      settled = true
      document.removeEventListener('keydown', onKeydown, { capture: true })
      overlay.remove()
      resolve(answer)
    }

    const revalidate = (): void => {
      const typed = task.value.trim()
      const issue = typed === '' ? null : taskNameError(typed)
      hint.textContent = issue ?? ''
      const chosen = rolesFor(roles, [...picked])
      cost.textContent = squadCost(typed || 'task', chosen)
      accept.textContent = `Open squad of ${chosen.length}`
      accept.disabled =
        typed === '' || prompt.value.trim() === '' || issue !== null || chosen.length < 2
    }

    const submit = (): void => {
      if (accept.disabled) return
      finish({
        task: task.value.trim(),
        roleIds: [...picked],
        prompt: prompt.value.trim(),
        ...(Object.keys(agents).length > 0 ? { agents: { ...agents } } : {})
      })
    }

    const onKeydown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        finish(null)
        return
      }
      // A brief is normally several lines, so plain Enter adds one and only the
      // modifier submits — the same bargain the fan-out dialog makes.
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.stopPropagation()
        submit()
      }
    }

    task.addEventListener('input', revalidate)
    prompt.addEventListener('input', revalidate)
    cancel.addEventListener('click', () => finish(null))
    accept.addEventListener('click', submit)
    overlay.addEventListener('pointerdown', (e) => {
      if (e.target === overlay) finish(null)
    })
    document.addEventListener('keydown', onKeydown, { capture: true })
    document.body.appendChild(overlay)
    revalidate()
    task.focus()
  })
}

/** Tab-bar entry point: find the repository, load its roles, ask, then do it. */
export async function openSquad(): Promise<void> {
  const cwd = currentRepoCwd()
  if (cwd === null) {
    await alertDialog(
      'Open a pane inside a git repository first — a squad needs somewhere to branch from.'
    )
    return
  }

  const { roles, error } = await window.lightclaude.roles.list(cwd)
  // Said before the dialog, not instead of it: the built-in squad still works,
  // and burying the reason would leave someone wondering why their roles.json
  // had no effect.
  if (error !== null) toast({ tone: 'warning', title: 'Using the built-in roles', detail: error })

  const req = await askSquad(roles, await window.lightclaude.agent.available())
  if (req === null) return
  await runSquad(cwd, roles, req)
}

/** The focused pane's directory, which is where the branches come from. */
function currentRepoCwd(): string | null {
  const tab = state.tabs.find((t) => t.id === state.activeTabId)
  if (!tab) return null
  const nodes = paneNodes(tab.layout)
  const node = nodes.find((p) => p.id === state.focusedPaneId) ?? nodes[0]
  return node?.cwd ?? tab.projectPath ?? null
}
