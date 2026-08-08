import { execFile } from 'child_process'
import { basename, dirname, join } from 'path'
import { promisify } from 'util'
import { branchNameError } from '../shared/git'
import type {
  BranchDeleteResult,
  GitInfo,
  WorktreeAddResult,
  WorktreeRemoveResult
} from '../shared/ipc'

/**
 * Just enough git for a terminal to say where it is.
 *
 * The point of worktrees here is that several agents can work on one repository
 * without treading on each other's files — six panes sharing one working tree is
 * a footgun, not a feature. So this module does two things and stops: it reports
 * the branch a pane is on, and it creates and removes worktrees.
 *
 * There is deliberately no diff view, no merge UI and no "pick the winner"
 * button. Those belong to an editor, and this is a terminal: `git` is already
 * installed, already better at it, and already what the user knows.
 */

const exec = promisify(execFile)
/** Long enough for a cold index on a large repository, short enough to fail. */
const TIMEOUT_MS = 10_000

/**
 * What actually went wrong, out of everything git said on the way down.
 *
 * git narrates progress on stderr and then fails underneath it, so the first
 * line is the wrong one to show. A real failure looks like:
 *
 *     Preparing worktree (new branch 'test-wt')
 *     fatal: a branch named 'test-wt' already exists
 *
 * Reporting line one told the user "Preparing worktree" over an OK button, which
 * says nothing and reads like success. The reason is the line that announces
 * itself as one; failing that, the last thing said before giving up.
 */
export function gitErrorMessage(stderr: string, fallback: string): string {
  const lines = stderr
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  const reason = lines.find((l) => /^(fatal|error):/i.test(l)) ?? lines[lines.length - 1]
  // The prefix is git's own shouting; the sentence after it is the useful part.
  return (reason ?? fallback).replace(/^(fatal|error):\s*/i, '').trim() || fallback
}

async function git(cwd: string, args: string[]): Promise<{ out: string; error: string | null }> {
  try {
    const { stdout } = await exec('git', args, { cwd, timeout: TIMEOUT_MS, windowsHide: true })
    return { out: stdout, error: null }
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr ?? ''
    return { out: '', error: gitErrorMessage(stderr, (err as Error).message) }
  }
}

/**
 * Where a worktree for `name` goes: `<repo>-worktrees/<name>`, next to the
 * repository rather than inside it.
 *
 * Outside, because inside is quietly destructive. This repository has no vitest
 * config, so `**' + '/*.test.ts` from the root would find a nested checkout's tests
 * as well and run all nine of them twice — sixteen fan-out copies would mean
 * running the suite seventeen times over, and .gitignore does not stop a test
 * runner. Worse for this app in particular: an agent told to work on the repo
 * would find every file sixteen times over and could edit the wrong copy, which
 * is the exact problem worktrees exist to prevent.
 *
 * One folder rather than loose siblings, because a fan-out of sixteen otherwise
 * puts sixteen folders next to the repository — an evening of testing left
 * twenty-two of them scattered across a Desktop. They are still outside, still
 * in `git worktree list`, and still somewhere you can read and cd to.
 *
 * A slash in a branch name is legal (`feat/auth`) but cannot go into a folder
 * name, so only the folder flattens it — the branch keeps the name you typed.
 *
 * Lives here rather than in shared/git.ts because it needs `path`, and the
 * renderer that shares the name rules has no node integration.
 */
export function worktreeDirFor(root: string, name: string): string {
  return join(dirname(root), `${basename(root)}-worktrees`, name.replace(/\//g, '-'))
}

/**
 * What the pane's directory is, git-wise. Two processes: one rev-parse for the
 * facts, one status for whether anything has changed.
 *
 * Called when a shell prompt renders rather than on a timer — that is precisely
 * when a command has just finished, so it is when the answer can have changed.
 * A clock would ask constantly and still be late.
 */
export async function gitInfo(cwd: string): Promise<GitInfo> {
  const absent: GitInfo = {
    repo: false,
    root: null,
    mainRoot: null,
    branch: null,
    dirty: false,
    worktree: false
  }

  // One process for all four. rev-parse prints results in argument order, and
  // --abbrev-ref stays in effect for everything after it, which is why no sha is
  // asked for here: it would come back as the branch name again.
  const { out, error } = await git(cwd, [
    'rev-parse',
    // Absolute, so the common dir can be turned into a path rather than the
    // bare ".git" git prints for the repository it is standing in.
    '--path-format=absolute',
    '--show-toplevel',
    '--git-dir',
    '--git-common-dir',
    '--abbrev-ref',
    'HEAD'
  ])
  if (error !== null) return absent

  const [root, gitDir, commonDir, head] = out.split('\n').map((l) => l.trim())
  if (!root || !gitDir || !commonDir) return absent

  const status = await git(cwd, ['status', '--porcelain', '--untracked-files=no'])

  return {
    repo: true,
    root,
    // <main>/.git for a worktree and for the repository alike, so its parent is
    // the repository either way.
    mainRoot: dirname(commonDir),
    // A detached HEAD reports the literal string "HEAD"; there is no branch to name.
    branch: head && head !== 'HEAD' ? head : null,
    // Untracked files are excluded on purpose: a build directory or a stray note
    // is not work in progress, and counting it would leave the marker always lit.
    dirty: status.error === null && status.out.trim() !== '',
    // In a linked worktree the git dir lives under <common>/worktrees/<name>; in
    // the repository itself the two are the same path.
    worktree: gitDir !== commonDir
  }
}

/** Create a worktree on a new branch and report where it landed. */
export async function addWorktree(cwd: string, name: string): Promise<WorktreeAddResult> {
  const nameError = branchNameError(name)
  if (nameError !== null) return { ok: false, error: nameError }

  const info = await gitInfo(cwd)
  if (!info.repo || info.root === null) {
    return { ok: false, error: 'This pane is not inside a git repository.' }
  }

  const path = worktreeDirFor(info.root, name)
  // `git worktree add` refuses a non-empty directory itself, but its message
  // talks about paths; naming the folder we chose is more use than that.
  const { error } = await git(info.root, ['worktree', 'add', '-b', name, path])
  if (error !== null) return { ok: false, error }
  return { ok: true, path, branch: name }
}

/**
 * Remove a worktree. Without `force`, git refuses when the worktree holds
 * modified or untracked files, and that refusal is the safety here — there is no
 * separate check to get wrong, and no way for this to quietly delete work. The
 * branch is left alone either way: removing a worktree is not abandoning it.
 */
export async function removeWorktree(
  cwd: string,
  path: string,
  force: boolean
): Promise<WorktreeRemoveResult> {
  const info = await gitInfo(cwd)
  if (!info.repo || info.root === null) {
    return { ok: false, error: 'This pane is not inside a git repository.' }
  }
  const args = ['worktree', 'remove', ...(force ? ['--force'] : []), path]
  const { error } = await git(info.root, args)
  if (error !== null) {
    // "use --force to delete it" is git telling us the work is not saved. The
    // caller turns that into a question rather than pressing on.
    return { ok: false, error, needsForce: /--force/.test(error) }
  }
  return { ok: true }
}


/**
 * Forget worktrees whose folders have already gone.
 *
 * Deleting a worktree folder in Finder leaves git's bookkeeping behind, and the
 * stale record keeps the branch checked out as far as git is concerned. Pruning
 * touches no files at all — it only drops records for directories that are not
 * there.
 */
export async function pruneWorktrees(cwd: string): Promise<void> {
  await git(cwd, ['worktree', 'prune'])
}

/**
 * Delete a branch, with git deciding whether that is allowed.
 *
 * Lowercase -d, never -D: git refuses a branch holding commits that exist
 * nowhere else, which is the same bargain the worktree removal makes. A
 * fan-out's branches are usually empty — nothing was committed to them — and
 * keeping twenty of those is not safety, it is litter that also makes the task
 * name unusable for ever.
 */
export async function deleteBranch(cwd: string, branch: string): Promise<BranchDeleteResult> {
  const { error } = await git(cwd, ['branch', '-d', branch])
  if (error === null) return { ok: true }
  return { ok: false, error, hasWork: /not fully merged/i.test(error) }
}
