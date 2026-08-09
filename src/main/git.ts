import { execFile } from 'child_process'
import { basename, dirname, join } from 'path'
import { promisify } from 'util'
import { branchNameError } from '../shared/git'
import type {
  BranchDeleteResult,
  GitInfo,
  PendingWork,
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
 * Split a `status --porcelain -z` run into what is changed and what git has
 * never heard of.
 *
 * NUL-separated rather than the readable form, because plain `--porcelain`
 * C-quotes any path with a space or a quote in it — `"my notes.md"` — and a
 * dialog naming the file that is about to be deleted must name the file, not a
 * shell-escaped rendering of it.
 *
 * The awkward part is renames: `R  new\0old\0` spends a second field on where
 * the file came from. Reading that field as another entry would report two files
 * for one move, and the extra name would be one that is no longer on disk —
 * listed to the user among the things about to be deleted.
 */
export function parsePorcelain(out: string): PendingWork {
  const modified: string[] = []
  const untracked: string[] = []
  const fields = out.split('\0')
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i] ?? ''
    // A clean tree prints nothing, and the trailing NUL leaves one empty field;
    // a real entry is two status letters, a space, and a path.
    if (entry.length < 4) continue
    const code = entry.slice(0, 2)
    const path = entry.slice(3)
    if (code.includes('R') || code.includes('C')) i++
    if (code === '??') untracked.push(path)
    else modified.push(path)
  }
  return { modified, untracked }
}

/**
 * Everything in `dir` that deleting the directory would take with it.
 *
 * `--untracked-files=normal` is spelled out rather than left to the default
 * because the default is a user setting. `status.showUntrackedFiles=no` is a
 * real thing people put in a config to make status fast on a huge repository,
 * and `git worktree remove` runs its own `git status` with no -u flag, so it
 * inherits it: verified against the real binary, a worktree holding an
 * untracked file is then removed silently, with no refusal, no --force and no
 * question. Asking explicitly is what makes this app's warning independent of
 * that config.
 *
 * `--ignore-submodules=none` matches the flag git's own check passes, so a dirty
 * submodule counts here exactly as it counts there.
 */
export async function pendingWork(dir: string): Promise<PendingWork> {
  const { out, error } = await git(dir, [
    'status',
    '--porcelain',
    '-z',
    '--untracked-files=normal',
    '--ignore-submodules=none'
  ])
  // A status that could not run reports nothing rather than inventing work: git
  // still refuses the removal on its own, and blocking a removal because our
  // reading failed would strand the user with a worktree they cannot delete.
  if (error !== null) return { modified: [], untracked: [] }
  return parsePorcelain(out)
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
    untracked: 0,
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

  // Untracked entries are asked for even though they are not "dirty", which
  // costs a directory walk `-uno` skipped. Worth it: without them the header can
  // only say "clean", and it was saying that about worktrees `git worktree
  // remove` refuses to delete — the disagreement that talked a user through a
  // "Delete anyway". Still one process; `normal` stops at an untracked directory
  // rather than descending, so a build folder is one entry and not a walk of it.
  const pending = await pendingWork(cwd)

  return {
    repo: true,
    root,
    // <main>/.git for a worktree and for the repository alike, so its parent is
    // the repository either way.
    mainRoot: dirname(commonDir),
    // A detached HEAD reports the literal string "HEAD"; there is no branch to name.
    branch: head && head !== 'HEAD' ? head : null,
    // Untracked files are excluded from this on purpose: a build directory or a
    // stray note is not work in progress, and counting it would leave the marker
    // always lit. They are reported beside it instead, so nothing has to choose
    // between a marker that is useless and a header that lies.
    dirty: pending.modified.length > 0,
    untracked: pending.untracked.length,
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
 * Remove a worktree. Without `force`, anything still in it stops the removal and
 * comes back named, for the caller to put in front of the user. The branch is
 * left alone either way: removing a worktree is not abandoning it.
 *
 * This used to lean entirely on git refusing, on the grounds that a separate
 * check is a thing to get wrong. Two problems with that, both real:
 *
 * git's refusal says "contains modified or untracked files" and nothing else,
 * so the question the user got was "uncommitted changes" over a header saying
 * clean — the app arguing with itself, and the user siding with the header.
 * Reading the worktree first means the question can list the files.
 *
 * And the refusal is not unconditional. `git worktree remove` shells out to its
 * own `git status` without -u, which honours `status.showUntrackedFiles=no`:
 * with that set, a worktree holding nothing but an untracked file is deleted
 * silently, no refusal to notice and no dialog to answer. Verified against the
 * real binary. pendingWork() asks for untracked entries explicitly, so this path
 * cannot be turned off by a config written for an unrelated reason.
 *
 * git is still the authority on everything else it guards — a locked worktree, a
 * dirty submodule, a path that is not a worktree at all — and its own message
 * still comes back for those.
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
  if (!force) {
    const pending = await pendingWork(path)
    if (pending.modified.length + pending.untracked.length > 0) {
      return {
        ok: false,
        error: `${path} contains modified or untracked files.`,
        needsForce: true,
        pending
      }
    }
  }
  const args = ['worktree', 'remove', ...(force ? ['--force'] : []), path]
  const { error } = await git(info.root, args)
  if (error !== null) {
    // "use --force to delete it" is git telling us the work is not saved. Reached
    // for whatever the read above could not see — a dirty submodule, say — so
    // there is no file list to offer and the caller falls back to git's sentence.
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
