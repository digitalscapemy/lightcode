import { focusPane, panes } from './app'
import { alertDialog } from './confirmDialog'
import { paneNodes } from './splitTree'
import { persist, state } from './store'
import type { GitBranchRow, GitTree } from '../../shared/ipc'

/**
 * Every branch in one repository, docked beside the panes.
 *
 * This is a read view, and the distinction from a diff viewer is not a quibble.
 * "Which branch is ahead of main, and which terminal is sitting on it" is
 * navigation — it is the question a window holding four agents raises
 * constantly, and answering it today means four `git` invocations typed by
 * hand. "What changed inside that branch" is an editor's job, and this app
 * still does not do it.
 *
 * Docked rather than a modal for the same reason: it is meant to be glanced at
 * while you work, and a Mission Control-style overlay would have to be opened,
 * read and closed every time.
 *
 * Refreshed on the shell-prompt signal every other git reader here uses, not on
 * a timer. A prompt render is the moment a command has just finished, which is
 * the only moment any of this can have changed.
 */

let panel: HTMLElement | null = null
let body: HTMLElement | null = null
/** Repository the panel is currently describing, so a refresh can be skipped. */
let showing: GitTree | null = null
let busy = false
/** Set while Integrate is walking a queue, so a refresh cannot start a second. */
let integrating = false

export function initGitTree(): void {
  panel = document.getElementById('git-panel')
  if (!panel) return
  panel.hidden = !(state.gitPanelOpen ?? false)
  build()
  if (!panel.hidden) refreshGitTree()
}

export function toggleGitTree(): void {
  if (!panel) return
  panel.hidden = !panel.hidden
  state.gitPanelOpen = !panel.hidden
  persist()
  if (!panel.hidden) refreshGitTree()
}

function build(): void {
  if (!panel) return
  panel.replaceChildren()

  const header = document.createElement('div')
  header.className = 'git-panel-header'
  const title = document.createElement('span')
  title.className = 'git-panel-title'
  title.textContent = 'Branches'
  const close = document.createElement('button')
  close.className = 'git-panel-close'
  close.textContent = '×'
  close.title = 'Hide the git tree'
  close.addEventListener('click', toggleGitTree)
  header.append(title, close)

  body = document.createElement('div')
  body.className = 'git-panel-body'
  panel.append(header, body)
}

/** The directory the panel describes: whichever pane has the focus. */
function subjectCwd(): string | null {
  const tab = state.tabs.find((t) => t.id === state.activeTabId)
  if (!tab) return null
  const nodes = paneNodes(tab.layout)
  const node = nodes.find((p) => p.id === state.focusedPaneId) ?? nodes[0]
  return node?.cwd ?? tab.projectPath ?? null
}

/**
 * Coalesce the refreshes, because the trigger fires far more often than the
 * answer changes.
 *
 * Every pane calls this when its shell draws a prompt, so sixteen busy panes
 * mean sixteen signals a second — and each read is a handful of git processes.
 * A short window collapses a burst into one read, and the trailing timer means
 * the *last* signal still produces a fresh picture rather than being dropped.
 */
const COALESCE_MS = 700
let pending: number | null = null
let lastRead = 0

export function refreshGitTree(): void {
  if (!panel || panel.hidden || pending !== null) return
  const wait = Math.max(0, COALESCE_MS - (Date.now() - lastRead))
  pending = window.setTimeout(() => {
    pending = null
    void read()
  }, wait)
}

async function read(): Promise<void> {
  if (!panel || panel.hidden) return
  if (busy) {
    // A read is already in flight. Come back rather than dropping this signal:
    // the in-flight one started before whatever just changed, so its answer is
    // already stale.
    refreshGitTree()
    return
  }
  const cwd = subjectCwd()
  if (cwd === null) return
  lastRead = Date.now()
  busy = true
  try {
    showing = await window.lightclaude.git.tree(cwd)
  } catch {
    showing = null // main is gone; leave the last picture rather than flashing
  } finally {
    busy = false
  }
  render()
}

function relative(iso: string): string {
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return ''
  const mins = Math.floor((Date.now() - then) / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

/** The pane sitting in this branch's worktree, if one is. */
function paneOn(row: GitBranchRow): { id: string; name: string } | null {
  if (row.worktreePath === null) return null
  for (const tab of state.tabs) {
    for (const node of paneNodes(tab.layout)) {
      const cwd = node.cwd ?? tab.projectPath
      if (cwd === row.worktreePath) {
        return { id: node.id, name: node.name ?? tab.name }
      }
    }
  }
  return null
}

function render(): void {
  if (!body) return
  body.replaceChildren()
  const tree = showing
  if (tree === null) {
    const empty = document.createElement('div')
    empty.className = 'git-panel-empty'
    // Not an error: a terminal in a plain folder has not gone wrong.
    empty.textContent = 'This pane is not in a git repository.'
    body.appendChild(empty)
    return
  }

  if (tree.mergeInProgress) {
    const note = document.createElement('div')
    note.className = 'git-panel-note'
    note.textContent = `A merge is unfinished on ${tree.base}. Resolve it in that pane before integrating anything else.`
    body.appendChild(note)
  }

  for (const row of tree.rows) {
    body.appendChild(renderRow(tree, row))
  }
}

function renderRow(tree: GitTree, row: GitBranchRow): HTMLElement {
  const el = document.createElement('div')
  el.className = 'git-row'
  const isBase = row.branch === tree.base
  if (isBase) el.classList.add('git-row-base')

  const top = document.createElement('div')
  top.className = 'git-row-top'

  const name = document.createElement('span')
  name.className = 'git-row-branch'
  name.textContent = row.branch
  top.appendChild(name)

  if (row.dirty === true || (row.untracked ?? 0) > 0) {
    const dot = document.createElement('span')
    dot.className = 'git-row-dirty'
    dot.textContent = '●'
    const notes: string[] = []
    if (row.dirty) notes.push('uncommitted changes')
    if ((row.untracked ?? 0) > 0) notes.push(`${row.untracked} untracked`)
    dot.title = notes.join(', ')
    top.appendChild(dot)
  }

  if (!isBase && (row.ahead > 0 || row.behind > 0)) {
    const counts = document.createElement('span')
    counts.className = 'git-row-counts'
    const parts: string[] = []
    if (row.ahead > 0) parts.push(`↑${row.ahead}`)
    if (row.behind > 0) parts.push(`↓${row.behind}`)
    counts.textContent = parts.join(' ')
    counts.title = `${row.ahead} commit(s) ${tree.base} does not have, ${row.behind} it has that this does not`
    top.appendChild(counts)
  }

  el.appendChild(top)

  const meta = document.createElement('div')
  meta.className = 'git-row-meta'
  const pane = paneOn(row)
  // The column that turns "four branches" into "these four terminals", which is
  // the entire reason this panel exists in a window full of agents.
  meta.textContent = [pane ? `▣ ${pane.name}` : null, relative(row.when), row.subject]
    .filter(Boolean)
    .join(' · ')
  meta.title = row.subject
  el.appendChild(meta)

  if (pane) {
    el.classList.add('git-row-clickable')
    el.addEventListener('click', () => focusPane(pane.id))
  }

  // Integrate is offered only where it means something: a branch with commits
  // the base lacks, which is not the base itself.
  if (!isBase && row.ahead > 0) {
    const action = document.createElement('button')
    action.className = 'git-row-action'
    action.textContent = 'Integrate'
    action.title = `Merge ${row.branch} into ${tree.base}, in the pane that is on ${tree.base}`
    action.addEventListener('click', (e) => {
      e.stopPropagation()
      void integrate(tree, row)
    })
    el.appendChild(action)
  }

  return el
}

// ---------- Integrate ----------

/**
 * Merge a branch into the base, by typing the command into the base pane.
 *
 * The app does not run the merge itself, and that is the point rather than a
 * limitation. Everything about this is already `git`: the command, the output,
 * the conflict, the resolution. What was missing was never the merging — it was
 * remembering which branch, in which pane, in which order. So the app supplies
 * that and the terminal supplies the rest, which also means the whole thing is
 * visible, interruptible, and in your shell history afterwards.
 *
 * Refuses rather than guesses when the preconditions are not met. Merging into
 * a pane with uncommitted work, or one that is not on the base branch, is how
 * an automated sequence produces a mess nobody can unpick.
 */
async function integrate(tree: GitTree, row: GitBranchRow): Promise<void> {
  if (integrating) return
  if (tree.mergeInProgress) {
    await alertDialog(
      `A merge is already half-finished on ${tree.base}. Finish or abort it in that pane first.`
    )
    return
  }

  const target = basePane(tree)
  if (target === null) {
    await alertDialog(
      `No pane is on ${tree.base}. Open one in the repository itself and check out ${tree.base} — the merge happens where you can see it.`
    )
    return
  }

  const pane = panes.get(target)
  const git = pane?.gitSnapshot() ?? null
  if (git?.dirty === true) {
    await alertDialog(
      `The ${tree.base} pane has uncommitted changes. Commit or stash them first — merging over them is how work disappears.`
    )
    return
  }

  integrating = true
  try {
    focusPane(target)
    // One command, typed, and then left alone. Not a queue of merges: the
    // second one would run against whatever the first one left behind, and if
    // that is a conflict it compounds silently.
    window.lightclaude.pty.write(target, `git merge --no-ff ${row.branch}\r`)
  } finally {
    integrating = false
  }
}

/** The pane checked out on the base branch, in the repository itself. */
function basePane(tree: GitTree): string | null {
  for (const [id, pane] of panes) {
    const git = pane.gitSnapshot()
    if (git?.branch === tree.base && git.mainRoot === tree.root && !git.worktree) return id
  }
  return null
}
