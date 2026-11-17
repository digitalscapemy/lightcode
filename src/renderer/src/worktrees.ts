import { choiceDialog, confirmDialog } from './confirmDialog'
import { paneNodes } from './splitTree'
import { state } from './store'
import { pendingWorkWarning } from '../../shared/git'
import { toast } from './ui/toast'

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
      // "uncommitted changes" alone would be a promise this does not make: an
      // untracked file is not a change to anything, and it is kept too.
      'holds commits, and keeps any worktree still holding edits or untracked files.',
    ['Close only', `Close and remove ${found.length}`]
  )
  if (choice === null) return 'cancel'
  return choice === 0 ? 'keep' : 'remove'
}

/**
 * Remove one worktree, asking before anything in it is lost. True when it went.
 *
 * The first attempt never forces, so nothing is deleted before the removal has
 * been described. What comes back is the list of files at stake, and that list
 * is the question: "uncommitted changes" was too vague to survive contact with
 * a header saying clean, and the one case where being vague costs something
 * irreplaceable — an untracked file, on no branch and in no commit — is
 * exactly the case the old wording described worst.
 *
 * Shared by the pane menu and the git panel, so the question is worded the same
 * wherever it is asked. The branch survives either way.
 */
export async function removeWorktreeAsking(cwd: string, worktreePath: string): Promise<boolean> {
  const first = await window.lightclaude.git.removeWorktree(cwd, worktreePath, false)
  if (first.ok) return true
  if (!first.needsForce) {
    toast({ tone: 'error', title: 'Could not remove the worktree', detail: first.error })
    return false
  }
  const pending = first.pending
  const doomed = pending ? pending.modified.length + pending.untracked.length : 0
  // The button carries the count too. "Delete anyway" invites the reading that
  // the app is being over-careful and can be waved past; a button that says
  // how many files it deletes cannot be pressed by someone who believes there
  // are none. Only reached without a list when git refused over something the
  // status read could not see, and then git's own sentence is all there is.
  const forced = await confirmDialog(
    (pending && pendingWorkWarning(pending)) ??
      'Removing this worktree deletes the folder and everything in it. ' +
        `git says: ${first.error ?? 'it still holds work'}`,
    doomed > 0 ? `Delete ${doomed} file${doomed === 1 ? '' : 's'}` : 'Delete anyway'
  )
  if (!forced) return false
  const second = await window.lightclaude.git.removeWorktree(cwd, worktreePath, true)
  if (!second.ok) {
    toast({ tone: 'error', title: 'Could not remove the worktree', detail: second.error })
    return false
  }
  return true
}

/**
 * Remove them, and report what git would not part with.
 *
 * Never forces. Bulk-deleting sixteen checkouts is the shape of action that
 * loses work, so a worktree holding anything at all — an edit, or a file nobody
 * ever added — is kept and named. Forcing one is still possible from its own
 * pane menu, one at a time, where the question is about something you are
 * looking at rather than a number in a list, and where it lists the files.
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
      `Kept ${keptWorktree.length} worktree${keptWorktree.length === 1 ? '' : 's'} still ` +
        `holding edits or untracked files: ${keptWorktree.join(', ')}. Remove one from its own ` +
        'pane menu if you meant to discard it, that is where it names what it deletes.'
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
