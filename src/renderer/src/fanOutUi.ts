import { createTab } from './app'
import { alertDialog } from './confirmDialog'
import {
  AGENT_COUNTS,
  agentCommand,
  layoutIdFor,
  branchNamesFor,
  taskNameError
} from './fanOut'
import type { AgentCount, FanOutRequest } from './fanOut'
import { LAYOUT_PRESETS, buildLayout } from './layouts'
import { newId, pendingCommand, state } from './store'
import { paneNodes } from './splitTree'
import type { LayoutNode } from '../../shared/types'


/**
 * Create the worktrees, then a tab of panes sitting in them.
 *
 * Worktrees are created one at a time on purpose: `git worktree add` writes the
 * index, and two of them at once race for its lock.
 */
export async function runFanOut(cwd: string, req: FanOutRequest): Promise<void> {
  const names = branchNamesFor(req.task, req.count)
  const created: string[] = []

  for (const name of names) {
    const result = await window.lightclaude.git.addWorktree(cwd, name)
    if (result.ok) {
      created.push(result.path)
      continue
    }
    // Undo the ones already made. They are seconds old and have never been
    // written to, so forcing is safe here in a way it never is for the user's
    // own worktrees — and leaving half a fan-out behind is worse than either.
    for (const path of created) {
      await window.lightclaude.git.removeWorktree(cwd, path, true)
    }
    await alertDialog(`Could not create ${name}: ${result.error}`)
    return
  }

  const preset = LAYOUT_PRESETS.find((p) => p.id === layoutIdFor(req.count))
  if (!preset) return
  const layout: LayoutNode = buildLayout(preset.spec, () => newId('p'))

  // paneNodes reads left to right, top to bottom, which is the order the
  // branches are numbered in — agent 3 is where you would point at agent 3.
  const nodes = paneNodes(layout)
  const command = agentCommand(req.prompt, window.lightclaude.platform === 'win32')
  nodes.forEach((node, i) => {
    node.cwd = created[i]
    // Runs when the pane's shell draws its first prompt. See store.pendingCommand.
    pendingCommand.set(node.id, command)
  })

  await createTab({
    projectPath: created[0] ?? cwd,
    name: req.task,
    layout,
    awaitSpawn: true
  })
}

// ---------- The dialog ----------

/**
 * Asks for the three things a fan-out needs. Built by hand rather than reusing
 * promptDialog because a count is a choice, not a line of text, and typing "4"
 * into a box is a worse way to pick one of three options.
 */
function askFanOut(): Promise<FanOutRequest | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div')
    overlay.id = 'shortcuts-overlay'
    const modal = document.createElement('div')
    modal.className = 'shortcuts-modal confirm-modal fanout-modal'

    const body = document.createElement('div')
    body.className = 'shortcuts-body confirm-text'

    const taskLabel = document.createElement('div')
    taskLabel.textContent = 'Task name — each agent gets a branch from it'
    const task = document.createElement('input')
    task.className = 'prompt-input'
    task.placeholder = 'auth-refactor'
    task.spellcheck = false

    const countLabel = document.createElement('div')
    countLabel.className = 'fanout-label'
    countLabel.textContent = 'Agents'
    const counts = document.createElement('div')
    counts.className = 'fanout-counts'
    let count: AgentCount = 3
    const countButtons = AGENT_COUNTS.map((n) => {
      const b = document.createElement('button')
      b.className = 'fanout-count'
      b.textContent = String(n)
      b.addEventListener('click', () => {
        count = n
        for (const other of countButtons) other.classList.toggle('active', other === b)
        revalidate()
      })
      counts.appendChild(b)
      return b
    })
    countButtons[AGENT_COUNTS.indexOf(count)]?.classList.add('active')

    const promptLabel = document.createElement('div')
    promptLabel.className = 'fanout-label'
    promptLabel.textContent = 'Prompt — sent to every agent'
    const prompt = document.createElement('textarea')
    prompt.className = 'prompt-input fanout-prompt'
    prompt.rows = 3
    prompt.placeholder = 'Refactor the auth module to use the new token API'
    prompt.spellcheck = false

    const hint = document.createElement('div')
    hint.className = 'prompt-hint'
    body.append(taskLabel, task, countLabel, counts, promptLabel, prompt, hint)

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
    const finish = (answer: FanOutRequest | null): void => {
      if (settled) return
      settled = true
      document.removeEventListener('keydown', onKeydown, { capture: true })
      overlay.remove()
      resolve(answer)
    }

    const revalidate = (): void => {
      const issue = task.value.trim() === '' ? null : taskNameError(task.value.trim())
      hint.textContent = issue ?? ''
      // Naming what is about to happen: four branches is not a small side effect
      // to discover afterwards.
      accept.textContent = `Fan out to ${count}`
      accept.disabled = task.value.trim() === '' || prompt.value.trim() === '' || issue !== null
    }

    const submit = (): void => {
      if (accept.disabled) return
      finish({ task: task.value.trim(), count, prompt: prompt.value.trim() })
    }

    const onKeydown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        finish(null)
        return
      }
      // Enter inside the prompt box adds a line; only the modifier submits, since
      // a multi-line prompt is the normal case here.
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

/** Tab-bar entry point: ask, then do it. */
export async function openFanOut(): Promise<void> {
  const cwd = currentRepoCwd()
  if (cwd === null) {
    await alertDialog('Open a pane inside a git repository first — a fan-out needs somewhere to branch from.')
    return
  }
  const req = await askFanOut()
  if (req === null) return
  await runFanOut(cwd, req)
}

/** The focused pane's directory, which is where the branches come from. */
function currentRepoCwd(): string | null {
  const tab = state.tabs.find((t) => t.id === state.activeTabId)
  if (!tab) return null
  const focused = state.focusedPaneId
  const node = paneNodes(tab.layout).find((p) => p.id === focused) ?? paneNodes(tab.layout)[0]
  return node?.cwd ?? tab.projectPath ?? null
}

