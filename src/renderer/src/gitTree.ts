import { basename, closePane, createTab, focusPane, panes, splitAt } from './app'
import { alertDialog, confirmDialog, promptDialog } from './confirmDialog'
import { paneNodes } from './splitTree'
import { newId, pendingCommand, persist, state } from './store'
import { removeWorktreeAsking } from './worktrees'
import { branchNameError } from '../../shared/git'
import type { GitBranchRow, GitBranchState, GitTree, GitWorktreeRow } from '../../shared/ipc'

/**
 * Every worktree of one repository, docked beside the panes — and where each
 * one stands against main and against GitHub.
 *
 * This is a read view first, and the distinction from a diff viewer is not a
 * quibble. "Which checkout is ahead of main, which has not been pushed, and
 * which terminal is sitting in it" is navigation — it is the question a window
 * holding four agents raises constantly, and answering it by hand means a round
 * of `git worktree list`, `git status` and `git log` in every folder. "What
 * changed inside that branch" is an editor's job, and this app still does not
 * do it.
 *
 * Worktrees rather than branches, because a worktree is the thing with a folder,
 * a pane and uncommitted work in it. Branches nobody has checked out are still
 * listed, folded away underneath.
 *
 * Docked rather than a modal for the same reason: it is meant to be glanced at
 * while you work, and a Mission Control-style overlay would have to be opened,
 * read and closed every time.
 *
 * Refreshed on the shell-prompt signal every other git reader here uses. The
 * one clock is the remote's: nothing local announces that someone pushed to
 * GitHub, so while the panel is open it fetches every few minutes — and that can
 * be switched off.
 */

let panel: HTMLElement | null = null
let body: HTMLElement | null = null
let addBtn: HTMLButtonElement | null = null
let fetchBtn: HTMLButtonElement | null = null
let autoBtn: HTMLButtonElement | null = null
/** Repository the panel is currently describing. */
let showing: GitTree | null = null
let busy = false
/** Set while Integrate is walking a queue, so a refresh cannot start a second. */
let integrating = false
let fetching = false
/** The last fetch's failure, shown until the next one succeeds or it is dismissed. */
let fetchError: string | null = null
/** The branches-without-a-worktree list is folded until asked for. */
let branchesOpen = false

/** How stale the remote may get before the panel fetches on its own. */
const AUTO_FETCH_MS = 5 * 60_000
/** How often it checks whether that has happened. Checking is free; fetching is not. */
const AUTO_CHECK_MS = 60_000
let autoTimer: number | null = null
/**
 * When each repository was last *attempted*, success or not. A fetch that fails
 * does not touch FETCH_HEAD, so without this an offline laptop would retry on
 * every single prompt render.
 */
const fetchAttempt = new Map<string, number>()

export function initGitTree(): void {
  panel = document.getElementById('git-panel')
  if (!panel) return
  panel.hidden = !(state.gitPanelOpen ?? false)
  build()
  syncAutoFetch()
  if (!panel.hidden) refreshGitTree()
}

export function toggleGitTree(): void {
  if (!panel) return
  panel.hidden = !panel.hidden
  state.gitPanelOpen = !panel.hidden
  persist()
  syncAutoFetch()
  if (!panel.hidden) refreshGitTree()
}

function build(): void {
  if (!panel) return
  panel.replaceChildren()

  const header = document.createElement('div')
  header.className = 'git-panel-header'
  const title = document.createElement('span')
  title.className = 'git-panel-title'
  title.textContent = 'Worktrees'

  const actions = document.createElement('div')
  actions.className = 'git-panel-actions'

  addBtn = headerButton('+', 'New worktree on a new branch', () => void newWorktree())
  fetchBtn = headerButton('⟳', 'Fetch', () => void fetchNow())

  autoBtn = document.createElement('button')
  autoBtn.className = 'git-panel-chip'
  autoBtn.textContent = 'auto'
  autoBtn.addEventListener('click', () => {
    state.gitAutoFetch = !state.gitAutoFetch
    persist()
    syncAutoFetch()
    renderHeader()
    maybeAutoFetch()
  })

  const close = headerButton('×', 'Hide the worktree panel', toggleGitTree)
  close.classList.add('git-panel-close')

  actions.append(addBtn, fetchBtn, autoBtn, close)
  header.append(title, actions)

  body = document.createElement('div')
  body.className = 'git-panel-body'
  panel.append(header, body)
  renderHeader()
}

function headerButton(text: string, tip: string, onClick: () => void): HTMLButtonElement {
  const btn = document.createElement('button')
  btn.className = 'git-panel-btn'
  btn.textContent = text
  btn.title = tip
  btn.addEventListener('click', onClick)
  return btn
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

/** Refresh without waiting out the coalescing window: the user just did something. */
function refreshNow(): void {
  lastRead = 0
  refreshGitTree()
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
  maybeAutoFetch()
}

// ---------- Fetching ----------

function syncAutoFetch(): void {
  const want = panel !== null && !panel.hidden && state.gitAutoFetch
  if (want && autoTimer === null) {
    autoTimer = window.setInterval(maybeAutoFetch, AUTO_CHECK_MS)
  } else if (!want && autoTimer !== null) {
    window.clearInterval(autoTimer)
    autoTimer = null
  }
}

/**
 * Fetch when what the panel knows about the remote has gone stale.
 *
 * Measured from whichever is later, the last fetch anyone made or the last one
 * this panel tried — so a `git pull` typed in a pane counts, switching to a
 * repository fetched a minute ago costs nothing, and a failing remote is
 * retried every few minutes rather than on every prompt.
 */
function maybeAutoFetch(): void {
  const tree = showing
  if (tree === null || tree.remote === null || fetching) return
  if (!state.gitAutoFetch || !panel || panel.hidden) return
  const tried = fetchAttempt.get(tree.root) ?? 0
  const fetched = tree.lastFetch ? Date.parse(tree.lastFetch) : 0
  if (Date.now() - Math.max(tried, Number.isNaN(fetched) ? 0 : fetched) >= AUTO_FETCH_MS) {
    void fetchNow()
  }
}

/**
 * Fetch from the remote, and say so if it fails — never more loudly than a note.
 *
 * A dialog would be the wrong weight: this also runs on its own every few
 * minutes, and an offline laptop is not an emergency. Everything local keeps
 * working with the last-known remote state.
 */
async function fetchNow(): Promise<void> {
  const tree = showing
  if (fetching || tree === null || tree.remote === null) return
  fetching = true
  fetchAttempt.set(tree.root, Date.now())
  renderHeader()
  try {
    const result = await window.lightclaude.git.fetch(tree.root)
    fetchError = result.ok ? null : (result.error ?? 'git gave no reason')
  } catch {
    fetchError = 'git could not be reached'
  } finally {
    fetching = false
  }
  renderHeader()
  render()
  refreshNow()
}

// ---------- Rendering ----------

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

/**
 * One spelling for a path, so git's and the shell's can be compared.
 *
 * git prints `C:/Projects/app` and PowerShell reports `C:\Projects\app`, and on
 * Windows and macOS the case of a folder name is not part of its identity.
 */
function normalPath(p: string): string {
  const slashed = p.split('\\').join('/').replace(/\/+$/, '')
  return window.lightclaude.platform === 'linux' ? slashed : slashed.toLowerCase()
}

/** Every pane whose shell is in this folder or somewhere below it. */
function panesAt(path: string): { id: string; name: string }[] {
  const root = normalPath(path)
  const found: { id: string; name: string }[] = []
  for (const tab of state.tabs) {
    for (const node of paneNodes(tab.layout)) {
      const cwd = normalPath(node.cwd ?? tab.projectPath)
      if (cwd === root || cwd.startsWith(root + '/')) {
        found.push({ id: node.id, name: node.name ?? panes.get(node.id)?.label() ?? tab.name })
      }
    }
  }
  return found
}

function renderHeader(): void {
  const tree = showing
  if (addBtn) addBtn.hidden = tree === null
  const remote = tree?.remote ?? null
  if (fetchBtn) {
    fetchBtn.hidden = remote === null
    fetchBtn.disabled = fetching
    fetchBtn.classList.toggle('spinning', fetching)
    const when = tree?.lastFetch ? `last fetched ${relative(tree.lastFetch)}` : 'never fetched'
    fetchBtn.title = fetching ? `Fetching from ${remote}…` : `Fetch from ${remote} — ${when}`
  }
  if (autoBtn) {
    autoBtn.hidden = remote === null
    autoBtn.classList.toggle('on', state.gitAutoFetch)
    autoBtn.title = state.gitAutoFetch
      ? 'Fetching on its own every 5 minutes while this panel is open. Click to stop.'
      : 'Only fetching when asked. Click to fetch every 5 minutes while this panel is open.'
  }
}

function render(): void {
  renderHeader()
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
    body.appendChild(
      note(
        `A merge is unfinished on ${tree.base}. Resolve it in that pane before integrating anything else.`
      )
    )
  }

  if (fetchError !== null && tree.remote !== null) {
    body.appendChild(
      // Not "from origin": the fetch covers every remote, and the one that failed
      // is named in git's own sentence. The others were still brought up to date.
      note(`Fetch failed — ${fetchError}`, 'Dismiss', () => {
        fetchError = null
        render()
      })
    )
  }

  const missing = tree.worktrees.filter((w) => w.prunable).length
  if (missing > 0) {
    body.appendChild(
      note(
        `${missing} worktree folder${missing === 1 ? ' has' : 's have'} been deleted, but git still ` +
          `lists ${missing === 1 ? 'it' : 'them'} and keeps the branch checked out.`,
        'Prune',
        () =>
          void window.lightclaude.git.pruneWorktrees(tree.root).then(refreshNow, refreshNow)
      )
    )
  }

  for (const row of tree.worktrees) body.appendChild(renderWorktree(tree, row))

  if (tree.branches.length > 0) {
    const section = document.createElement('button')
    section.className = 'git-section-header'
    section.textContent = `${branchesOpen ? '▾' : '▸'} Branches without a worktree (${tree.branches.length})`
    section.addEventListener('click', () => {
      branchesOpen = !branchesOpen
      render()
    })
    body.appendChild(section)
    if (branchesOpen) {
      for (const row of tree.branches) body.appendChild(renderBranch(tree, row))
    }
  }
}

function note(text: string, action?: string, onAction?: () => void): HTMLElement {
  const el = document.createElement('div')
  el.className = 'git-panel-note'
  const span = document.createElement('span')
  span.className = 'git-note-text'
  span.textContent = text
  el.appendChild(span)
  if (action && onAction) {
    const btn = document.createElement('button')
    btn.className = 'git-note-btn'
    btn.textContent = action
    btn.addEventListener('click', onAction)
    el.appendChild(btn)
  }
  return el
}

/** The ↑↓-against-main and ⇡⇣-against-GitHub counts, right-aligned on a row. */
function renderCounts(tree: GitTree, branch: string | null, row: GitBranchState): HTMLElement {
  const right = document.createElement('span')
  right.className = 'git-row-right'

  if (branch !== null && branch !== tree.base && (row.ahead > 0 || row.behind > 0)) {
    const counts = document.createElement('span')
    counts.className = 'git-row-counts'
    const parts: string[] = []
    if (row.ahead > 0) parts.push(`↑${row.ahead}`)
    if (row.behind > 0) parts.push(`↓${row.behind}`)
    counts.textContent = parts.join(' ')
    counts.title = `${row.ahead} commit(s) ${tree.base} does not have, ${row.behind} it has that this does not`
    right.appendChild(counts)
  }

  // Nothing is said about the remote in a repository that has none, and nothing
  // about a detached checkout, which has no branch to push.
  if (tree.remote !== null && branch !== null) {
    const sync = document.createElement('span')
    sync.className = 'git-row-upstream'
    if (row.upstreamGone) {
      sync.textContent = 'gone'
      sync.classList.add('git-row-upstream-warn')
      sync.title = `${row.upstream} was deleted on the remote — merged and cleaned up, usually`
    } else if (row.upstream === null) {
      sync.textContent = 'local'
      sync.title = `Never pushed: there is no ${tree.remote}/${branch} yet`
    } else if (row.upstreamAhead > 0 || row.upstreamBehind > 0) {
      const parts: string[] = []
      if (row.upstreamAhead > 0) parts.push(`⇡${row.upstreamAhead}`)
      if (row.upstreamBehind > 0) parts.push(`⇣${row.upstreamBehind}`)
      sync.textContent = parts.join(' ')
      sync.classList.add('git-row-upstream-pending')
      sync.title =
        `${row.upstreamAhead} commit(s) not pushed to ${row.upstream}, ` +
        `${row.upstreamBehind} on it not pulled yet (as of the last fetch)`
    } else {
      sync.textContent = '✓'
      sync.title = `Level with ${row.upstream} as of the last fetch`
    }
    right.appendChild(sync)
  }
  return right
}

function badge(text: string, tip: string, warn = false): HTMLElement {
  const el = document.createElement('span')
  el.className = warn ? 'git-row-badge git-row-badge-warn' : 'git-row-badge'
  el.textContent = text
  el.title = tip
  return el
}

function actionButton(label: string, tip: string, onClick: () => void): HTMLButtonElement {
  const btn = document.createElement('button')
  btn.className = 'git-row-action'
  btn.textContent = label
  btn.title = tip
  btn.addEventListener('click', (e) => {
    e.stopPropagation()
    onClick()
  })
  return btn
}

function renderWorktree(tree: GitTree, row: GitWorktreeRow): HTMLElement {
  const el = document.createElement('div')
  el.className = 'git-row'
  if (row.isMain) el.classList.add('git-row-base')
  if (row.prunable) el.classList.add('git-row-missing')

  const top = document.createElement('div')
  top.className = 'git-row-top'

  const name = document.createElement('span')
  name.className = 'git-row-branch'
  name.textContent = row.branch ?? `detached @${row.head.slice(0, 7)}`
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
  if (row.locked) top.appendChild(badge('locked', 'git worktree lock — git will not remove it'))
  if (row.prunable) top.appendChild(badge('missing', 'The folder is gone. Prune to forget it.', true))

  top.appendChild(renderCounts(tree, row.branch, row))
  el.appendChild(top)

  const sitting = row.prunable ? [] : panesAt(row.path)
  const meta = document.createElement('div')
  meta.className = 'git-row-meta'
  // The column that turns "four worktrees" into "these four terminals", which
  // is the entire reason this panel exists in a window full of agents.
  // One pane is named; several are counted. A repository checkout with six
  // shells in it would otherwise read "PowerShell, PowerShell, PowerShell, P…",
  // which names nothing and pushes the folder and subject off the row.
  meta.textContent = [
    sitting.length === 1
      ? `▣ ${sitting[0]?.name}`
      : sitting.length > 1
        ? `▣ ${sitting.length} panes`
        : null,
    row.isMain ? 'repo' : basename(row.path),
    relative(row.when),
    row.subject
  ]
    .filter(Boolean)
    .join(' · ')
  meta.title = [
    row.path,
    row.subject,
    sitting.length > 1 ? `Panes: ${sitting.map((p) => p.name).join(', ')}` : ''
  ]
    .filter(Boolean)
    .join('\n')
  el.appendChild(meta)

  if (!row.prunable) {
    el.classList.add('git-row-clickable')
    el.title = sitting.length > 0 ? 'Go to its pane' : 'Open a pane in this worktree'
    el.addEventListener('click', () => void focusOrOpen(row.path))
  }

  const actions = document.createElement('div')
  actions.className = 'git-row-actions'

  if (row.branch !== null && !row.prunable) {
    if (row.upstream !== null && !row.upstreamGone && row.upstreamBehind > 0) {
      actions.appendChild(
        actionButton('Pull', `git pull --ff-only, in this worktree's pane`, () =>
          void runInWorktree(row.path, 'git pull --ff-only')
        )
      )
    }
    const push = pushCommand(tree, row)
    if (push !== null) {
      actions.appendChild(
        actionButton('Push', `${push}, in this worktree's pane`, () =>
          void runInWorktree(row.path, push)
        )
      )
    }
  }

  // Integrate is offered only where it means something: a branch with commits
  // the base lacks, which is not the base itself.
  if (row.branch !== null && row.branch !== tree.base && row.ahead > 0) {
    const branch = row.branch
    actions.appendChild(
      actionButton('Integrate', `Merge ${branch} into ${tree.base}, in the pane that is on ${tree.base}`, () =>
        void integrate(tree, branch)
      )
    )
  }

  if (!row.isMain) {
    actions.appendChild(
      actionButton('Remove', 'Remove this worktree. The branch is kept.', () =>
        void removeFromPanel(tree, row)
      )
    )
  }

  if (actions.childElementCount > 0) el.appendChild(actions)
  return el
}

function renderBranch(tree: GitTree, row: GitBranchRow): HTMLElement {
  const el = document.createElement('div')
  el.className = 'git-row'

  const top = document.createElement('div')
  top.className = 'git-row-top'
  const name = document.createElement('span')
  name.className = 'git-row-branch'
  name.textContent = row.branch
  top.append(name, renderCounts(tree, row.branch, row))
  el.appendChild(top)

  const meta = document.createElement('div')
  meta.className = 'git-row-meta'
  meta.textContent = [relative(row.when), row.subject].filter(Boolean).join(' · ')
  meta.title = row.subject
  el.appendChild(meta)

  const actions = document.createElement('div')
  actions.className = 'git-row-actions'
  actions.appendChild(
    actionButton('Open worktree', `Check ${row.branch} out in a worktree of its own, and open a pane there`, () =>
      void checkout(tree, row.branch)
    )
  )
  if (row.branch !== tree.base && row.ahead > 0) {
    actions.appendChild(
      actionButton('Integrate', `Merge ${row.branch} into ${tree.base}, in the pane that is on ${tree.base}`, () =>
        void integrate(tree, row.branch)
      )
    )
  }
  el.appendChild(actions)
  return el
}

// ---------- Acting on a worktree ----------

/**
 * A name that can be typed into a shell as it is.
 *
 * git allows `;`, `$`, `&` and backticks in a branch name, and PowerShell and
 * bash quote differently, so rather than quote for two shells anything outside
 * the ordinary set is not typed at all. The panel says so instead.
 */
function shellSafe(name: string): boolean {
  return /^[A-Za-z0-9._/-]+$/.test(name) && !name.startsWith('-')
}

/**
 * What Push should type, or null when there is nothing to push.
 *
 * A branch never pushed gets `-u <remote> HEAD`, which publishes it under its
 * own name and sets the tracking in one go — and never has to spell the branch
 * name out. It is offered only once there is something on it: a fan-out's fresh
 * branches are level with main, and a Push on every one of them is noise.
 */
function pushCommand(tree: GitTree, row: GitWorktreeRow): string | null {
  if (tree.remote === null || row.branch === null) return null
  const unpublished = row.upstream === null || row.upstreamGone
  if (unpublished) {
    if (row.ahead === 0 && row.branch !== tree.base) return null
    return shellSafe(tree.remote) ? `git push -u ${tree.remote} HEAD` : null
  }
  return row.upstreamAhead > 0 ? 'git push' : null
}

/**
 * Put a pane in this worktree and bring it forward: the one already there if
 * there is one, otherwise a new split beside the focused pane.
 */
async function openAt(path: string, command?: string): Promise<void> {
  const tab = state.tabs.find((t) => t.id === state.activeTabId)
  const nodes = tab ? paneNodes(tab.layout) : []
  const target = nodes.find((n) => n.id === state.focusedPaneId) ?? nodes[0]
  if (target) {
    await splitAt(target.id, 'row', false, path, command)
    return
  }
  const id = newId('p')
  if (command !== undefined) pendingCommand.set(id, command)
  await createTab({ projectPath: path, layout: { type: 'pane', id } })
}

/**
 * Type a git command into the worktree's own pane.
 *
 * The app does not pull or push by itself, and that is the point rather than a
 * limitation: a pull can conflict and a push can ask for a password, and both
 * belong in a terminal where the question can be answered and the output read.
 *
 * A pane with Claude running in it is not typed into — the command would land
 * in the agent's prompt as a request — so a fresh pane is opened beside it.
 */
async function runInWorktree(path: string, command: string): Promise<void> {
  for (const pane of panesAt(path)) {
    const agent = await window.lightclaude.pty.claudeActive(pane.id)
    if (agent) continue
    focusPane(pane.id)
    window.lightclaude.pty.write(pane.id, `${command}\r`)
    return
  }
  await openAt(path, command)
}

/** Open a pane where this worktree is, or jump to the one already there. */
async function focusOrOpen(path: string): Promise<void> {
  const [first] = panesAt(path)
  if (first) focusPane(first.id)
  else await openAt(path)
}

async function newWorktree(): Promise<void> {
  const tree = showing
  if (tree === null) return
  const name = await promptDialog({
    // Branched from whatever the repository's own checkout is on, which is what
    // `git worktree add -b` does when it is run there.
    message: 'New worktree — branch name',
    placeholder: 'auth-fix',
    confirmLabel: 'Create',
    validate: branchNameError
  })
  if (name === null) return
  const result = await window.lightclaude.git.addWorktree(tree.root, name)
  if (!result.ok) {
    await alertDialog(result.error)
    return
  }
  await openAt(result.path)
  refreshNow()
}

async function checkout(tree: GitTree, branch: string): Promise<void> {
  const result = await window.lightclaude.git.checkoutWorktree(tree.root, branch)
  if (!result.ok) {
    await alertDialog(result.error)
    return
  }
  await openAt(result.path)
  refreshNow()
}

/**
 * Remove a worktree from the panel, closing any pane standing in it.
 *
 * Those panes are said out loud first. A shell whose directory has just been
 * deleted from under it is useless, so they have to close — but closing a
 * terminal somebody is looking at is not something to do as a side effect.
 */
async function removeFromPanel(tree: GitTree, row: GitWorktreeRow): Promise<void> {
  const sitting = panesAt(row.path)
  if (sitting.length > 0) {
    const many = sitting.length !== 1
    const go = await confirmDialog(
      `${sitting.length} pane${many ? 's are' : ' is'} open in ${basename(row.path)} ` +
        `(${sitting.map((p) => p.name).join(', ')}). Removing the worktree closes ${many ? 'them' : 'it'}.`,
      'Continue'
    )
    if (!go) return
  }
  if (!(await removeWorktreeAsking(tree.root, row.path))) return
  for (const pane of sitting) closePane(pane.id)
  refreshNow()
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
async function integrate(tree: GitTree, branch: string): Promise<void> {
  if (integrating) return
  if (tree.mergeInProgress) {
    await alertDialog(
      `A merge is already half-finished on ${tree.base}. Finish or abort it in that pane first.`
    )
    return
  }

  if (!shellSafe(branch)) {
    await alertDialog(
      `${branch} has characters a shell would read as more than a name, so it is not typed for you. Run the merge by hand.`
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
    window.lightclaude.pty.write(target, `git merge --no-ff ${branch}\r`)
  } finally {
    integrating = false
  }
}

/** The pane checked out on the base branch, in the repository itself. */
function basePane(tree: GitTree): string | null {
  for (const [id, pane] of panes) {
    const git = pane.gitSnapshot()
    if (
      git?.branch === tree.base &&
      git.mainRoot !== null &&
      normalPath(git.mainRoot) === normalPath(tree.root) &&
      !git.worktree
    ) {
      return id
    }
  }
  return null
}
