import { execFile } from 'child_process'
import { mkdir, stat } from 'fs/promises'
import { basename, dirname, join } from 'path'
import { promisify } from 'util'
import { branchNameError } from '../shared/git'
import type {
  BranchDeleteResult,
  FetchResult,
  GitBranchRow,
  GitInfo,
  GitTree,
  GitWorktreeRow,
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
 *
 * The one network operation it runs itself is `fetch`, because fetching only
 * updates what the app can *see* of the remote and changes no branch and no
 * file. Pull and push do change things, so those are typed into a pane where
 * their output, their prompts and their refusals stay in front of the user.
 */

const exec = promisify(execFile)
/** The field separator the -z and %00 formats below emit. */
const NUL = String.fromCharCode(0)
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

/** Long enough for a slow remote over a bad connection, short enough to give up. */
const NETWORK_TIMEOUT_MS = 60_000

interface GitOptions {
  /**
   * The command talks to a remote. It gets the longer timeout, and it is told
   * never to ask for credentials: a fetch runs in the background every few
   * minutes with no terminal attached, and a prompt nobody can see would sit
   * there until the timeout — or, with Git Credential Manager, pop a login
   * window over whatever the user was doing. Failing and saying so is better.
   */
  network?: boolean
}

async function git(
  cwd: string,
  args: string[],
  opts: GitOptions = {}
): Promise<{ out: string; error: string | null }> {
  try {
    const { stdout } = await exec('git', args, {
      cwd,
      timeout: opts.network ? NETWORK_TIMEOUT_MS : TIMEOUT_MS,
      windowsHide: true,
      ...(opts.network
        ? { env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' } }
        : {})
    })
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
 * Give a branch that already exists a worktree of its own.
 *
 * The other half of addWorktree: that one makes a new branch, this one checks
 * out a branch nobody is sitting in — the "Open worktree" on a row of the
 * panel's branch list. Beside the repository, in the same folder, for the same
 * reasons. git refuses a branch already checked out elsewhere, and says where.
 */
export async function checkoutWorktree(cwd: string, branch: string): Promise<WorktreeAddResult> {
  const nameError = branchNameError(branch)
  if (nameError !== null) return { ok: false, error: nameError }

  const info = await gitInfo(cwd)
  if (!info.repo || info.mainRoot === null) {
    return { ok: false, error: 'This pane is not inside a git repository.' }
  }

  const exists = await git(info.mainRoot, [
    'rev-parse',
    '--verify',
    '--quiet',
    `refs/heads/${branch}`
  ])
  if (exists.error !== null) return { ok: false, error: `There is no branch named ${branch}.` }

  const path = worktreeDirFor(info.mainRoot, branch)
  const { error } = await git(info.mainRoot, ['worktree', 'add', path, branch])
  if (error !== null) return { ok: false, error }
  return { ok: true, path, branch }
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

// ---------- Reading the shape of the repository ----------
//
// Everything below reads and nothing writes. It exists because the answer to
// "where are my four branches" currently takes four git invocations by hand,
// which in a window holding four agents is a question asked constantly.
//
// This is not the diff viewer the header of this file rules out, and the
// distinction is not a quibble: showing which branch is ahead of main is
// navigation, and showing what changed inside it is an editor's job. The panel
// built on this stops at the former.

/** One linked worktree, as `git worktree list --porcelain` describes it. */
export interface WorktreeRecord {
  path: string
  /** Commit checked out there. Empty only for a bare repository's entry. */
  head: string
  /** Branch checked out there, or null when the checkout is detached. */
  branch: string | null
  /** `git worktree lock`ed: git refuses to remove or prune it. */
  locked: boolean
  /** Its folder is gone; the record is only waiting for `worktree prune`. */
  prunable: boolean
}

/**
 * Every worktree of this repository, the repository's own checkout included.
 *
 * Porcelain rather than the human format: the readable one aligns columns with
 * spaces, and a path with a space in it then cannot be told from the column
 * after it. Records are blank-line separated, one `key value` per line.
 */
export async function listWorktrees(cwd: string): Promise<WorktreeRecord[]> {
  const { out, error } = await git(cwd, ['worktree', 'list', '--porcelain'])
  if (error !== null) return []
  const records: WorktreeRecord[] = []
  let current: WorktreeRecord | null = null
  const flush = (): void => {
    if (current !== null) records.push(current)
    current = null
  }
  for (const line of out.split('\n')) {
    const text = line.trimEnd()
    if (text === '') {
      flush()
      continue
    }
    if (text.startsWith('worktree ')) {
      flush()
      current = {
        path: text.slice('worktree '.length),
        head: '',
        branch: null,
        locked: false,
        prunable: false
      }
      continue
    }
    if (current === null) continue
    // `locked` and `prunable` may carry a reason after a space, or stand alone.
    const [key] = text.split(' ', 1)
    if (key === 'HEAD') current.head = text.slice('HEAD '.length)
    else if (key === 'branch') {
      // Printed as a full ref; the panel and the pane header both speak short names.
      current.branch = text.slice('branch '.length).replace(/^refs\/heads\//, '')
    } else if (key === 'locked') current.locked = true
    else if (key === 'prunable') current.prunable = true
  }
  flush()
  return records
}

/** Where a branch stands against the remote branch it tracks. */
export interface TrackState {
  ahead: number
  behind: number
  /** It tracks a remote branch that no longer exists — deleted after a merge, usually. */
  gone: boolean
}

/**
 * Read `%(upstream:track,nobracket)`.
 *
 * git prints `ahead 2, behind 1`, either half alone, `gone`, or nothing at all
 * when the two are level. Read from the same for-each-ref that lists the
 * branches, so thirty branches cost no extra processes — and measured against
 * the last fetch, which is exactly as current as the remote is ever known to be.
 */
export function parseTrack(text: string): TrackState {
  const trimmed = text.trim()
  if (trimmed === 'gone') return { ahead: 0, behind: 0, gone: true }
  const ahead = /ahead (\d+)/.exec(trimmed)
  const behind = /behind (\d+)/.exec(trimmed)
  return {
    ahead: ahead ? Number(ahead[1]) : 0,
    behind: behind ? Number(behind[1]) : 0,
    gone: false
  }
}

/** One local branch and its tip, before it is measured against anything. */
export interface BranchRecord {
  branch: string
  head: string
  subject: string
  when: string
  /** The remote branch it tracks, `origin/feat`, or null when it tracks none. */
  upstream: string | null
  track: TrackState
}

/**
 * Every local branch, newest commit first.
 *
 * The separator is a NUL between fields and a record terminator git will not
 * emit itself, because a commit subject can contain anything at all — including
 * whatever single character looked safe when this was written.
 */
export async function listBranches(cwd: string): Promise<BranchRecord[]> {
  const { out, error } = await git(cwd, [
    'for-each-ref',
    '--sort=-committerdate',
    '--format=%(refname:short)%00%(objectname)%00%(committerdate:iso-strict)%00%(upstream:short)%00%(upstream:track,nobracket)%00%(contents:subject)%00%0a',
    'refs/heads'
  ])
  if (error !== null) return []
  const rows: BranchRecord[] = []
  for (const record of out.split(NUL + '\n')) {
    if (record.trim() === '') continue
    const [branch, head, when, upstream, track, subject] = record.replace(/^\n/, '').split(NUL)
    if (!branch || !head) continue
    rows.push({
      branch,
      head,
      subject: subject ?? '',
      when: when ?? '',
      upstream: upstream ? upstream : null,
      track: parseTrack(track ?? '')
    })
  }
  return rows
}

/**
 * How far apart two branches are: commits each has that the other has not.
 *
 * This is the local half of the picture — "has this worktree's work reached
 * main yet" — and it stays local on purpose. The remote half, "has it reached
 * GitHub", comes from the upstream tracking on each branch instead, because a
 * repository that has never been pushed has no origin/main to measure against
 * and would read as zero.
 */
export async function divergence(
  cwd: string,
  base: string,
  branch: string
): Promise<{ ahead: number; behind: number }> {
  if (base === branch) return { ahead: 0, behind: 0 }
  const { out, error } = await git(cwd, [
    'rev-list',
    '--left-right',
    '--count',
    `${base}...${branch}`
  ])
  if (error !== null) return { ahead: 0, behind: 0 }
  const [behind, ahead] = out.trim().split(/\s+/).map(Number)
  return {
    ahead: Number.isFinite(ahead) ? ahead : 0,
    behind: Number.isFinite(behind) ? behind : 0
  }
}

/**
 * The branch everything else is measured against.
 *
 * origin/HEAD first, because a repository with a remote has already answered
 * this question and its answer beats a guess. Falling back to whichever of main
 * or master exists — and finally to the current branch, so a repository using
 * neither name still gets a coherent panel rather than an empty one.
 */
export async function defaultBranch(cwd: string): Promise<string | null> {
  const head = await git(cwd, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
  if (head.error === null) {
    const name = head.out.trim().replace(/^origin\//, '')
    if (name) return name
  }
  for (const name of ['main', 'master']) {
    const { error } = await git(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`])
    if (error === null) return name
  }
  const current = await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])
  const name = current.out.trim()
  return name && name !== 'HEAD' ? name : null
}

/**
 * True when a merge has been started here and not finished.
 *
 * This is what Integrate stops on. Running the next merge against a conflicted
 * tree is how an automated sequence turns one conflict into a mess nobody can
 * unpick, so the queue halts and the terminal keeps the half-done merge — which
 * is where `git` resolves it.
 */
export async function mergeInProgress(cwd: string): Promise<boolean> {
  const { error } = await git(cwd, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])
  return error === null
}

/**
 * The remote the panel fetches from and pushes to: origin when there is one,
 * otherwise whichever remote exists, and null for a repository never connected
 * to anything — which the panel shows by not offering to sync at all.
 */
export async function primaryRemote(cwd: string): Promise<string | null> {
  const { out, error } = await git(cwd, ['remote'])
  if (error !== null) return null
  const names = out
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  if (names.includes('origin')) return 'origin'
  return names[0] ?? null
}

/**
 * When this repository last fetched, from FETCH_HEAD's modification time.
 *
 * git keeps no other record of it, and FETCH_HEAD is rewritten by every fetch
 * whoever ran it — this app, a `git pull` in a pane, an IDE — so it answers the
 * question actually being asked: how stale is what we know about the remote.
 */
export async function lastFetchTime(cwd: string): Promise<string | null> {
  const { out, error } = await git(cwd, [
    'rev-parse',
    '--path-format=absolute',
    '--git-path',
    'FETCH_HEAD'
  ])
  if (error !== null) return null
  try {
    return (await stat(out.trim())).mtime.toISOString()
  } catch {
    return null // never fetched
  }
}

/**
 * Bring the app's picture of every remote up to date.
 *
 * `--prune` so a branch deleted on GitHub after its PR merged stops being
 * tracked here too, which is what lets the panel say "upstream gone" rather
 * than go on counting commits against a ref that no longer exists anywhere.
 * Changes no local branch and no file.
 */
export async function fetchRemotes(cwd: string): Promise<FetchResult> {
  const info = await gitInfo(cwd)
  if (!info.repo || info.mainRoot === null) {
    return { ok: false, error: 'This pane is not inside a git repository.' }
  }
  const { error } = await git(info.mainRoot, ['fetch', '--all', '--prune', '--quiet'], {
    network: true
  })
  return error === null ? { ok: true } : { ok: false, error }
}

/** Subject and date of whatever a detached checkout is sitting on. */
async function commitSummary(cwd: string): Promise<{ subject: string; when: string }> {
  const { out, error } = await git(cwd, ['log', '-1', '--format=%s%x00%cI'])
  if (error !== null) return { subject: '', when: '' }
  const [subject, when] = out.trim().split(NUL)
  return { subject: subject ?? '', when: when ?? '' }
}

/**
 * The whole picture: every worktree of the repository, what it holds, how far
 * its branch has moved from the base and from GitHub — and every branch that no
 * worktree holds, below them.
 *
 * Returns null when the directory is not in a repository, which the panel shows
 * as nothing rather than as an error — a terminal sitting in a plain folder has
 * not gone wrong.
 */
export async function gitTree(cwd: string): Promise<GitTree | null> {
  const info = await gitInfo(cwd)
  if (!info.repo || info.mainRoot === null) return null
  const root = info.mainRoot

  const base = await defaultBranch(root)
  if (base === null) return null

  const [branches, records, remote, lastFetch, merging] = await Promise.all([
    listBranches(root),
    listWorktrees(root),
    primaryRemote(root),
    lastFetchTime(root),
    mergeInProgress(root)
  ])
  const byName = new Map(branches.map((b) => [b.branch, b]))
  const held = new Set<string>()

  // In parallel, and that is not premature. This runs whenever a shell prompt
  // renders; a repository with thirty branches would otherwise spawn sixty git
  // processes one after another while the panel sat there empty.
  const worktrees: GitWorktreeRow[] = await Promise.all(
    records.map(async (w, index): Promise<GitWorktreeRow> => {
      const b = w.branch === null ? undefined : byName.get(w.branch)
      if (w.branch !== null) held.add(w.branch)
      const [counts, pending, summary] = await Promise.all([
        w.branch === null ? { ahead: 0, behind: 0 } : divergence(root, base, w.branch),
        // A folder that is gone has no status to read, and asking git to run in
        // it would fail anyway; saying "clean" would imply the folder exists.
        w.prunable ? Promise.resolve(null) : pendingWork(w.path),
        b !== undefined || w.prunable
          ? Promise.resolve({ subject: b?.subject ?? '', when: b?.when ?? '' })
          : commitSummary(w.path)
      ])
      return {
        path: w.path,
        branch: w.branch,
        head: w.head,
        subject: summary.subject,
        when: summary.when,
        ahead: counts.ahead,
        behind: counts.behind,
        upstream: b?.upstream ?? null,
        upstreamAhead: b?.track.ahead ?? 0,
        upstreamBehind: b?.track.behind ?? 0,
        upstreamGone: b?.track.gone ?? false,
        dirty: pending === null ? null : pending.modified.length > 0,
        untracked: pending === null ? null : pending.untracked.length,
        // git always lists the repository's own checkout first.
        isMain: index === 0,
        locked: w.locked,
        prunable: w.prunable
      }
    })
  )

  // The repository's own checkout stays on top — it is the anchor everything is
  // merged into — and the rest follow the branches' newest-commit-first order.
  const [main, ...linked] = worktrees
  linked.sort((a, b) => (b.when > a.when ? 1 : b.when < a.when ? -1 : 0))

  const loose: GitBranchRow[] = await Promise.all(
    branches
      .filter((b) => !held.has(b.branch))
      .map(async (b): Promise<GitBranchRow> => {
        const counts = await divergence(root, base, b.branch)
        return {
          branch: b.branch,
          head: b.head,
          subject: b.subject,
          when: b.when,
          ahead: counts.ahead,
          behind: counts.behind,
          upstream: b.upstream,
          upstreamAhead: b.track.ahead,
          upstreamBehind: b.track.behind,
          upstreamGone: b.track.gone
        }
      })
  )

  return {
    root,
    base,
    remote,
    lastFetch,
    worktrees: main === undefined ? [] : [main, ...linked],
    branches: loose,
    mergeInProgress: merging
  }
}

/**
 * The folder a squad shares, created and ready to be written into.
 *
 * Beside the repository for the same reason worktrees are: inside it, a report
 * an agent wrote would show up as an untracked file in everybody's `git
 * status`, and the squad's notes-to-each-other would end up in the diff being
 * reviewed. The name carries the task, so two squads on one repository do not
 * read each other's post.
 *
 * `reports/` is made now rather than by whichever agent finishes first, because
 * an agent that has to create the directory has to be told to, and that is a
 * sentence in every role's prompt paid for on every turn.
 */
export async function prepareSquad(cwd: string, task: string): Promise<string | null> {
  const info = await gitInfo(cwd)
  if (!info.repo || info.mainRoot === null) return null
  const dir = worktreeDirFor(info.mainRoot, `${task}-squad`)
  try {
    await mkdir(join(dir, 'reports'), { recursive: true })
  } catch {
    return null
  }
  return dir
}
