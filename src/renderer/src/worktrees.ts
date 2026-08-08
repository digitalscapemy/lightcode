import { alertDialog, choiceDialog } from './confirmDialog'
import { paneNodes } from './splitTree'
import { state } from './store'

/**
 * Deciding what to do with a worktree when its window onto the repository is
 * about to close.
 *
 * Separate from fanOutUi because app.ts needs it too — a pane's × asks the same
 * question a tab's × does — and fanOutUi imports app, so putting it there would
 * make a cycle. Nothing here touches the DOM beyond a dialog.
 */

export interface Worktree {
  paneId: string
  path: string
  branch: string | null
  mainRoot: string
}

async function worktreeAt(paneId: string, cwd: string | undefined): Promise<Worktree | null> {
  if (!cwd) return null
  const info = await window.lightclaude.git.info(cwd)
  if (!info.repo || !info.worktree || !info.root || !info.mainRoot) return null
  return { paneId, path: info.root, branch: info.branch, mainRoot: info.mainRoot }
}

/** Which of a tab's panes sit in worktrees — asked of git, not remembered. */
export async function worktreesInTab(tabId: string): Promise<Worktree[]> {
  const tab = state.tabs.find((t) => t.id === tabId)
  if (!tab) return []
  const found: Worktree[] = []
  for (const node of paneNodes(tab.layout)) {
    const wt = await worktreeAt(node.id, node.cwd)
    if (wt) found.push(wt)
  }
  return found
}

/** The worktree one pane sits in, if any. */
export async function worktreeOfPane(paneId: string): Promise<Worktree | null> {
  for (const tab of state.tabs) {
    const node = paneNodes(tab.layout).find((p) => p.id === paneId)
    if (node) return worktreeAt(paneId, node.cwd)
  }
  return null
}

/**
 * Ask what should happen to these worktrees. Returns true when they should go.
 *
 * Three answers rather than two, because "close but keep them" is a real thing
 * to want and folding it into a yes/no would make it unreachable. Dismissing
 * cancels the close entirely — the safe answer is never the accidental one.
 */
export async function askRemove(found: Worktree[]): Promise<'remove' | 'keep' | 'cancel'> {
  const many = found.length !== 1
  const names = found.map((c) => c.branch ?? c.path).join(', ')
  const choice = await choiceDialog(
    `${many ? 'These panes are' : 'This pane is'} using ${found.length} worktree` +
      `${many ? 's' : ''}: ${names}. Removing ${many ? 'them' : 'it'} keeps every branch that ` +
      'holds commits, and keeps anything with uncommitted changes.',
    ['Close only', `Close and remove ${found.length}`]
  )
  if (choice === null) return 'cancel'
  return choice === 0 ? 'keep' : 'remove'
}

/**
 * Remove them, and report what git would not part with.
 *
 * Never forces. Bulk-deleting sixteen checkouts is the shape of action that
 * loses work, so a worktree holding uncommitted changes is kept and named.
 * Forcing one is still possible from its own pane menu, one at a time, where the
 * question is about something you are looking at rather than a number in a list.
 */
export async function removeAll(found: Worktree[]): Promise<string[]> {
  const repo = found[0]?.mainRoot
  if (repo === undefined) return []
  const keptWorktree: string[] = []
  const keptBranch: string[] = []

  for (const c of found) {
    const removed = await window.lightclaude.git.removeWorktree(c.path, c.path, false)
    if (!removed.ok) {
      keptWorktree.push(c.branch ?? c.path)
      continue
    }
    if (c.branch === null) continue
    // Lowercase -d inside deleteBranch: a branch holding commits survives and
    // says so. An empty one is litter, and while it exists the task name it came
    // from can never be fanned out again.
    const deleted = await window.lightclaude.git.deleteBranch(repo, c.branch)
    if (!deleted.ok) keptBranch.push(c.branch)
  }

  // A folder deleted outside git leaves its record behind, and that record keeps
  // the branch looking checked out. Touches no files.
  await window.lightclaude.git.pruneWorktrees(repo)

  const notes: string[] = []
  if (keptWorktree.length > 0) {
    notes.push(
      `Kept ${keptWorktree.length} worktree${keptWorktree.length === 1 ? '' : 's'} with ` +
        `uncommitted changes: ${keptWorktree.join(', ')}. Remove one from its own pane menu ` +
        'if you meant to discard it.'
    )
  }
  if (keptBranch.length > 0) {
    notes.push(
      `Kept ${keptBranch.length} branch${keptBranch.length === 1 ? '' : 'es'} holding commits: ` +
        `${keptBranch.join(', ')}. The worktrees are gone; the work is not.`
    )
  }
  return notes
}
