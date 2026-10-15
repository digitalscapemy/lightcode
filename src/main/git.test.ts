import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { basename, dirname, join } from 'path'
import { beforeAll, describe, expect, it } from 'vitest'
import { branchNameError, pendingWorkWarning } from '../shared/git'
import {
  addWorktree,
  checkoutWorktree,
  defaultBranch,
  deleteBranch,
  divergence,
  fetchRemotes,
  gitErrorMessage,
  gitInfo,
  gitTree,
  listBranches,
  listWorktrees,
  mergeInProgress,
  parsePorcelain,
  parseTrack,
  primaryRemote,
  pruneWorktrees,
  removeWorktree,
  worktreeDirFor
} from './git'

/**
 * A temp directory named the way git will name it back.
 *
 * Two platform quirks, one helper. On Windows, `tmpdir()` can be an 8.3 short
 * path (`MIKHAI~1`) while git always prints the long form, so a plain string
 * compare fails on a machine whose profile name has a space in it — and passes
 * on one whose name does not, which is the worst kind of test. On macOS,
 * `/var` is a symlink to `/private/var` and git reports the resolved path.
 * `realpathSync.native` settles both; plain `realpathSync` settles only the
 * second.
 */
function tempDir(prefix: string): string {
  return realpathSync.native(mkdtempSync(join(tmpdir(), prefix)))
}

/** Compare paths without arguing about which slash git chose to print. */
function samePath(a: string | null | undefined, b: string): void {
  const slash = (p: string): string => p.split('\\').join('/')
  expect(slash(String(a))).toBe(slash(b))
}

describe('branchNameError', () => {
  it.each(['auth-fix', 'feat/auth', 'v2.1', 'a_b-c', 'WIP123'])('accepts %s', (name) => {
    expect(branchNameError(name)).toBeNull()
  })

  // Each of these is legal to git in some form, or fails with a message about
  // refs rather than about the name — neither helps someone who just typed it.
  it.each([
    ['', 'empty'],
    ['   ', 'only spaces'],
    ['my branch', 'a space in the middle'],
    ['-x', 'a leading dash, which reads as a flag'],
    ['.hidden', 'a leading dot'],
    ['trailing.', 'a trailing dot'],
    ['a..b', 'a double dot, which reads as a range'],
    ['head@{1}', '@{'],
    ['thing.lock', '.lock'],
    ['/leading', 'a leading slash'],
    ['trailing/', 'a trailing slash'],
    ['a//b', 'a double slash'],
    ['ca^ret', '^'],
    ['til~de', '~'],
    ['co:lon', ':'],
    ['ques?tion', '?'],
    ['aster*isk', '*'],
    ['brack[et', '['],
    ['back\\slash', '\\']
  ])('rejects %j — %s', (name) => {
    expect(branchNameError(name)).not.toBeNull()
  })

  it('gives a sentence rather than a code', () => {
    expect(branchNameError('my branch')).toMatch(/spaces/)
  })

  it('rejects a control character', () => {
    expect(branchNameError(`a${String.fromCharCode(9)}b`)).not.toBeNull()
  })
})

describe('gitErrorMessage', () => {
  // The exact stderr git produced when a worktree add hit an existing branch.
  // Reporting its first line put "Preparing worktree" over an OK button, which
  // reads like success and explains nothing.
  const worktreeExists =
    "Preparing worktree (new branch 'test-wt')\nfatal: a branch named 'test-wt' already exists\n"

  it('reports the failure, not the progress line above it', () => {
    expect(gitErrorMessage(worktreeExists, 'fallback')).toBe(
      "a branch named 'test-wt' already exists"
    )
  })

  it('strips the prefix git shouts, keeping the sentence', () => {
    expect(gitErrorMessage('fatal: not a git repository', 'x')).toBe('not a git repository')
    expect(gitErrorMessage('error: pathspec is unknown', 'x')).toBe('pathspec is unknown')
  })

  // Not everything git fails on announces itself with a prefix; the last thing
  // said before giving up is the best guess left.
  it('falls back to the last line when nothing is labelled', () => {
    expect(gitErrorMessage('doing a thing\nit went wrong', 'x')).toBe('it went wrong')
  })

  it('uses the fallback when git said nothing at all', () => {
    expect(gitErrorMessage('', 'spawn git ENOENT')).toBe('spawn git ENOENT')
    expect(gitErrorMessage('   \n  \n', 'spawn git ENOENT')).toBe('spawn git ENOENT')
  })

  it('never returns an empty string, whatever it is handed', () => {
    expect(gitErrorMessage('fatal:', 'fallback')).toBe('fallback')
  })
})

describe('parsePorcelain', () => {
  // The exact bytes `git status --porcelain -z` produced for a staged rename, an
  // edited file and two untracked entries. One of the paths has a space in it,
  // which the readable form C-quotes into "untracked file.txt" — a name no
  // dialog should ever show back to the person who chose it.
  const status = 'R  new name.txt\0old name.txt\0 M sub/keep.txt\0?? untracked file.txt\0?? build/\0'

  it('separates what git knows about from what it has never seen', () => {
    expect(parsePorcelain(status)).toEqual({
      modified: ['new name.txt', 'sub/keep.txt'],
      untracked: ['untracked file.txt', 'build/']
    })
  })

  // The second field of a rename says where the file came from. Reading it as
  // another entry would count one move as two files, and would name a path that
  // is already gone among the things about to be deleted.
  it("does not read a rename's old path as another file", () => {
    expect(parsePorcelain(status).modified).not.toContain('old name.txt')
  })

  it('finds nothing in a clean tree', () => {
    expect(parsePorcelain('')).toEqual({ modified: [], untracked: [] })
  })
})

/**
 * The sentence that stands between a fan-out pane and a file that exists nowhere
 * else. It replaced "This worktree still has uncommitted changes", which was
 * read — against a header saying clean — as the app being over-careful.
 */
describe('pendingWorkWarning', () => {
  it('says nothing when there is nothing to lose', () => {
    expect(pendingWorkWarning({ modified: [], untracked: [] })).toBeNull()
  })

  // A file that was never added is not a change to anything, and the branch the
  // dialog promises to keep has no copy of it.
  it('names an untracked file and refuses to promise it back', () => {
    const text = pendingWorkWarning({ modified: [], untracked: ['notes/draft.md'] })
    expect(text).toContain('notes/draft.md')
    expect(text).toContain('1 untracked file')
    expect(text).toContain('nothing brings it back')
  })

  it('offers the branch as comfort only for work that is on it', () => {
    const text = pendingWorkWarning({ modified: ['src/a.ts'], untracked: [] })
    expect(text).toContain('src/a.ts')
    expect(text).toContain('The branch keeps every commit')
    expect(text).not.toContain('untracked')
  })

  it('keeps both halves apart when there is some of each', () => {
    const text = pendingWorkWarning({ modified: ['src/a.ts'], untracked: ['draft.md'] })
    expect(text).toContain('1 modified file (src/a.ts) and 1 untracked file (draft.md)')
  })

  it('stops naming files before the list stops being read', () => {
    const text = pendingWorkWarning({ modified: [], untracked: ['a', 'b', 'c', 'd', 'e', 'f'] })
    expect(text).toContain('6 untracked files (a, b, c, d and 2 more)')
  })
})

describe('worktreeDirFor', () => {
  // Never inside: with no vitest config, a nested checkout's tests are found by
  // the root's own **/*.test.ts and run alongside them, and an agent searching
  // the repo finds every file twice.
  it('keeps the worktree outside the repository', () => {
    const dir = worktreeDirFor('/work/lightcode', 'auth-fix')
    expect(dir.startsWith('/work/lightcode/')).toBe(false)
  })

  // One folder, not loose siblings: a fan-out of sixteen would otherwise put
  // sixteen directories next to the repository.
  it('gathers them under one folder beside the repository', () => {
    expect(worktreeDirFor('/work/lightcode', 'auth-fix')).toBe(
      join('/work', 'lightcode-worktrees', 'auth-fix')
    )
    expect(worktreeDirFor('/work/lightcode', 'other')).toBe(
      join('/work', 'lightcode-worktrees', 'other')
    )
    expect(dirname(worktreeDirFor('/work/lightcode', 'a'))).toBe(
      dirname(worktreeDirFor('/work/lightcode', 'b'))
    )
  })

  // A slash is legal in a branch name but cannot go into a folder name; only the
  // folder flattens, so the branch keeps what was typed.
  it('flattens a slash in the folder name only', () => {
    expect(basename(worktreeDirFor('/work/repo', 'feat/auth'))).toBe('feat-auth')
  })
})

/**
 * These run the real git binary against a throwaway repository. The point is the
 * behaviour this feature leans on — particularly that git itself refuses to
 * remove a worktree holding uncommitted work, which is the whole safety story
 * and would be worth nothing if it were only assumed.
 */
describe('worktrees, against real git', () => {
  let repo: string
  let gitPresent = true

  beforeAll(() => {
    try {
      execFileSync('git', ['--version'], { stdio: 'ignore' })
    } catch {
      gitPresent = false
      return
    }
    // realpath, because macOS /var is a symlink to /private/var and git reports
    // the resolved path — comparing the two forms fails for no useful reason.
    repo = join(tempDir('lc-git-'), 'repo')
    const run = (args: string[]): void => {
      execFileSync('git', args, { cwd: repo, stdio: 'ignore' })
    }
    execFileSync('git', ['init', '-q', '-b', 'main', repo], { stdio: 'ignore' })
    writeFileSync(join(repo, 'a.txt'), 'hi\n')
    run(['add', '.'])
    run(['-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-qm', 'init'])
  })

  it.skipIf(!gitPresent)('reads the repository it is standing in', async () => {
    const info = await gitInfo(repo)
    expect(info).toMatchObject({ repo: true, branch: 'main', dirty: false, worktree: false })
    samePath(info.root, repo)
  })

  it.skipIf(!gitPresent)('says nothing at all outside a repository', async () => {
    const info = await gitInfo(tempDir('lc-bare-'))
    expect(info).toEqual({
      repo: false,
      root: null,
      mainRoot: null,
      branch: null,
      dirty: false,
      untracked: 0,
      worktree: false
    })
  })

  it.skipIf(!gitPresent)('notices a tracked file changing', async () => {
    writeFileSync(join(repo, 'a.txt'), 'changed\n')
    expect((await gitInfo(repo)).dirty).toBe(true)
    writeFileSync(join(repo, 'a.txt'), 'hi\n')
    expect((await gitInfo(repo)).dirty).toBe(false)
  })

  // An untracked build directory or stray note is not work in progress, and
  // counting it as dirty would leave the marker lit for ever. It is still
  // reported, separately: the header may not say "clean" about a directory that
  // `git worktree remove` refuses to delete.
  it.skipIf(!gitPresent)('reports untracked files without calling them dirty', async () => {
    writeFileSync(join(repo, 'scratch.txt'), 'note\n')
    const info = await gitInfo(repo)
    expect(info.dirty).toBe(false)
    expect(info.untracked).toBe(1)
  })

  it.skipIf(!gitPresent)('refuses a bad branch name without running git', async () => {
    const result = await addWorktree(repo, 'my branch')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/spaces/)
  })

  it.skipIf(!gitPresent)('creates a worktree beside the repo and knows it is one', async () => {
    const added = await addWorktree(repo, 'auth-fix')
    expect(added.ok).toBe(true)
    if (!added.ok) return
    samePath(added.path, worktreeDirFor(repo, 'auth-fix'))
    expect(existsSync(added.path)).toBe(true)

    const inside = await gitInfo(added.path)
    expect(inside).toMatchObject({ repo: true, branch: 'auth-fix', worktree: true })
    // The repository itself must not start calling itself a worktree.
    expect((await gitInfo(repo)).worktree).toBe(false)
  })

  // Branch work has to run in the repository: a worktree's own directory stops
  // existing the moment it is removed.
  it.skipIf(!gitPresent)('points at the repository from inside a worktree', async () => {
    const path = worktreeDirFor(repo, 'auth-fix')
    samePath((await gitInfo(path)).mainRoot, repo)
    samePath((await gitInfo(repo)).mainRoot, repo)
  })

  it.skipIf(!gitPresent)('will not reuse a branch name', async () => {
    const again = await addWorktree(repo, 'auth-fix')
    expect(again.ok).toBe(false)
  })

  // The safety this feature relies on is git's, not ours: no separate dirty
  // check to get wrong, and no path that deletes work without being told twice.
  it.skipIf(!gitPresent)('refuses to remove a worktree holding uncommitted work', async () => {
    const path = worktreeDirFor(repo, 'auth-fix')
    writeFileSync(join(path, 'a.txt'), 'work in progress\n')
    const refused = await removeWorktree(repo, path, false)
    expect(refused.ok).toBe(false)
    expect(refused.needsForce).toBe(true)
  })

  it.skipIf(!gitPresent)('removes it when forced, and keeps the branch', async () => {
    const path = worktreeDirFor(repo, 'auth-fix')
    const forced = await removeWorktree(repo, path, true)
    expect(forced.ok).toBe(true)
    expect(existsSync(path)).toBe(false)
    // Removing a worktree is not abandoning the branch.
    const branches = execFileSync('git', ['branch', '--list', 'auth-fix'], {
      cwd: repo,
      encoding: 'utf8'
    })
    expect(branches.trim()).not.toBe('')
  })
})

/**
 * What a removal says before it deletes anything.
 *
 * The failure being covered is not git's. git refuses a worktree holding an
 * untracked file — but only while it is allowed to look, and the app used to
 * answer that refusal with the words "uncommitted changes" over a header that
 * said "clean". An untracked file is the one thing removal destroys that no
 * branch, no commit and no object database can give back.
 */
describe.skipIf(process.platform === 'win32')('removeWorktree names what it destroys', () => {
  async function worktreeWith(seed: (dir: string) => void): Promise<{ repo: string; path: string }> {
    const repo = join(tempDir('lc-pending-'), 'repo')
    execFileSync('git', ['init', '-q', '-b', 'main', repo], { stdio: 'ignore' })
    writeFileSync(join(repo, 'a.txt'), 'hi\n')
    execFileSync('git', ['add', '.'], { cwd: repo, stdio: 'ignore' })
    execFileSync('git', ['-c', 'user.email=t@e.com', '-c', 'user.name=t', 'commit', '-qm', 'init'], {
      cwd: repo,
      stdio: 'ignore'
    })
    const added = await addWorktree(repo, 'wt')
    if (!added.ok) throw new Error(added.error)
    seed(added.path)
    return { repo, path: added.path }
  }

  it('refuses over an untracked file, names it, and deletes nothing yet', async () => {
    const { repo, path } = await worktreeWith((dir) => writeFileSync(join(dir, 'draft.md'), 'new\n'))
    const result = await removeWorktree(repo, path, false)
    expect(result.ok).toBe(false)
    expect(result.needsForce).toBe(true)
    expect(result.pending).toEqual({ modified: [], untracked: ['draft.md'] })
    // The attempt that asks the question must not be the one that answers it.
    expect(existsSync(join(path, 'draft.md'))).toBe(true)
  })

  it('names a modified tracked file too', async () => {
    const { repo, path } = await worktreeWith((dir) => writeFileSync(join(dir, 'a.txt'), 'edited\n'))
    const result = await removeWorktree(repo, path, false)
    expect(result.pending).toEqual({ modified: ['a.txt'], untracked: [] })
  })

  // Why there is a check here at all rather than a reading of git's refusal.
  // `git worktree remove` shells out to its own `git status` with no -u flag, so
  // this config reaches it: without asking for untracked entries ourselves the
  // removal below simply succeeds, and the file is gone with nothing ever asked.
  it('still refuses when status.showUntrackedFiles is turned off', async () => {
    const { repo, path } = await worktreeWith((dir) => writeFileSync(join(dir, 'draft.md'), 'new\n'))
    execFileSync('git', ['config', 'status.showUntrackedFiles', 'no'], {
      cwd: repo,
      stdio: 'ignore'
    })
    // git itself, asked the same question, would go ahead:
    const gitsOwnView = execFileSync('git', ['status', '--porcelain'], { cwd: path, encoding: 'utf8' })
    expect(gitsOwnView.trim()).toBe('')

    const result = await removeWorktree(repo, path, false)
    expect(result.ok).toBe(false)
    expect(result.pending?.untracked).toEqual(['draft.md'])
    expect(existsSync(join(path, 'draft.md'))).toBe(true)
  })

  // git collapses a wholly untracked directory into one entry rather than
  // walking it, and so does the warning: "1 untracked file (build/)" is what a
  // person can act on, four hundred names is not.
  it('counts an untracked directory once, the way git does', async () => {
    const { repo, path } = await worktreeWith((dir) => {
      mkdirSync(join(dir, 'build'))
      writeFileSync(join(dir, 'build', 'out.js'), 'x\n')
      writeFileSync(join(dir, 'build', 'out.css'), 'y\n')
    })
    const result = await removeWorktree(repo, path, false)
    expect(result.pending?.untracked).toEqual(['build/'])
  })

  it('removes one with nothing in it without being forced', async () => {
    const { repo, path } = await worktreeWith(() => {})
    expect(await removeWorktree(repo, path, false)).toEqual({ ok: true })
    expect(existsSync(path)).toBe(false)
  })
})

/**
 * Branch cleanup. A fan-out leaves one branch per agent, and in plan mode not
 * one of them has a commit — keeping twenty of those is not safety, it is litter
 * that also makes the task name unusable for ever. The safety is git's: -d
 * refuses a branch whose commits live nowhere else.
 */
describe.skipIf(process.platform === 'win32')('deleteBranch, against real git', () => {
  function repoWith(branches: { name: string; commit?: boolean }[]): string {
    const dir = join(tempDir('lc-branch-'), 'repo')
    execFileSync('git', ['init', '-q', '-b', 'main', dir], { stdio: 'ignore' })
    const run = (args: string[]): void => {
      execFileSync('git', ['-c', 'user.email=t@e.com', '-c', 'user.name=t', ...args], {
        cwd: dir,
        stdio: 'ignore'
      })
    }
    writeFileSync(join(dir, 'a.txt'), 'hi\n')
    run(['add', '.'])
    run(['commit', '-qm', 'init'])
    for (const b of branches) {
      run(['branch', b.name])
      if (!b.commit) continue
      run(['checkout', '-q', b.name])
      writeFileSync(join(dir, `${b.name}.txt`), 'work\n')
      run(['add', '.'])
      run(['commit', '-qm', `work on ${b.name}`])
      run(['checkout', '-q', 'main'])
    }
    return dir
  }

  it('deletes a branch that never diverged', async () => {
    const repo = repoWith([{ name: 'empty-1' }])
    expect(await deleteBranch(repo, 'empty-1')).toEqual({ ok: true })
    const left = execFileSync('git', ['branch', '--list', 'empty-1'], { cwd: repo, encoding: 'utf8' })
    expect(left.trim()).toBe('')
  })

  // The whole reason -d is used rather than -D. An agent that actually committed
  // something must not lose it to a tidy-up.
  it('refuses one holding commits, and says why', async () => {
    const repo = repoWith([{ name: 'real-work', commit: true }])
    const result = await deleteBranch(repo, 'real-work')
    expect(result.ok).toBe(false)
    expect(result.hasWork).toBe(true)
    const left = execFileSync('git', ['branch', '--list', 'real-work'], {
      cwd: repo,
      encoding: 'utf8'
    })
    expect(left.trim()).not.toBe('')
  })

  it('reports a branch that was never there rather than throwing', async () => {
    const repo = repoWith([])
    const result = await deleteBranch(repo, 'never-existed')
    expect(result.ok).toBe(false)
    expect(result.hasWork).toBe(false)
  })
})

describe.skipIf(process.platform === 'win32')('pruneWorktrees', () => {
  // Deleting the folder in Finder leaves git's record behind, and the stale
  // record keeps the branch looking checked out — so the name cannot be reused.
  it('forgets a worktree whose folder was deleted outside git', async () => {
    const repo = join(tempDir('lc-prune-'), 'repo')
    execFileSync('git', ['init', '-q', '-b', 'main', repo], { stdio: 'ignore' })
    writeFileSync(join(repo, 'a.txt'), 'hi\n')
    execFileSync('git', ['add', '.'], { cwd: repo, stdio: 'ignore' })
    execFileSync(
      'git',
      ['-c', 'user.email=t@e.com', '-c', 'user.name=t', 'commit', '-qm', 'init'],
      { cwd: repo, stdio: 'ignore' }
    )
    const added = await addWorktree(repo, 'gone')
    expect(added.ok).toBe(true)
    if (!added.ok) return

    rmSync(added.path, { recursive: true, force: true })
    const before = execFileSync('git', ['worktree', 'list'], { cwd: repo, encoding: 'utf8' })
    expect(before).toContain('gone')

    await pruneWorktrees(repo)
    const after = execFileSync('git', ['worktree', 'list'], { cwd: repo, encoding: 'utf8' })
    expect(after).not.toContain('worktrees')
  })
})

/**
 * The git tree readers, against the real binary.
 *
 * A separate repository from the block above, because these need branches with
 * commits on them and that block deliberately keeps a clean single-commit
 * history for the worktree tests to reason about.
 */
describe('the git tree, against real git', () => {
  let gitPresent = true
  let repo = ''

  const run = (args: string[], cwd = repo): void => {
    execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], {
      cwd,
      stdio: 'ignore'
    })
  }

  beforeAll(() => {
    try {
      execFileSync('git', ['--version'], { stdio: 'ignore' })
    } catch {
      gitPresent = false
      return
    }
    repo = join(tempDir('lc-tree-'), 'repo')
    execFileSync('git', ['init', '-q', '-b', 'main', repo], { stdio: 'ignore' })
    writeFileSync(join(repo, 'a.txt'), 'one\n')
    run(['add', '.'])
    run(['commit', '-qm', 'init'])

    // A branch two commits ahead of main, with a subject worth parsing: the
    // format is NUL-separated precisely because a subject can contain anything.
    run(['checkout', '-q', '-b', 'feature'])
    writeFileSync(join(repo, 'b.txt'), 'two\n')
    run(['add', '.'])
    run(['commit', '-qm', 'add b, with a comma and "quotes"'])
    writeFileSync(join(repo, 'c.txt'), 'three\n')
    run(['add', '.'])
    run(['commit', '-qm', 'add c'])
    run(['checkout', '-q', 'main'])
  })

  it.skipIf(!gitPresent)('finds main without a remote to ask', async () => {
    expect(await defaultBranch(repo)).toBe('main')
  })

  it.skipIf(!gitPresent)('counts how far a branch has moved from the base', async () => {
    expect(await divergence(repo, 'main', 'feature')).toEqual({ ahead: 2, behind: 0 })
    // Behind is the mirror of ahead, not a second measurement of it.
    expect(await divergence(repo, 'feature', 'main')).toEqual({ ahead: 0, behind: 2 })
  })

  it.skipIf(!gitPresent)('measures a branch against itself as nothing', async () => {
    expect(await divergence(repo, 'main', 'main')).toEqual({ ahead: 0, behind: 0 })
  })

  it.skipIf(!gitPresent)('lists branches with subjects intact', async () => {
    const rows = await listBranches(repo)
    const feature = rows.find((r) => r.branch === 'feature')
    expect(feature?.subject).toBe('add c')
    expect(rows.map((r) => r.branch).sort()).toEqual(['feature', 'main'])
    // A commit subject can hold anything, so the separator must not be a
    // character a person might type.
    const beta = rows.find((r) => r.branch === 'main')
    expect(beta?.head).toMatch(/^[0-9a-f]{40}$/)
  })

  it.skipIf(!gitPresent)('reports the repository itself as a worktree record', async () => {
    const records = await listWorktrees(repo)
    samePath(records.find((r) => r.branch === 'main')?.path, repo)
  })

  it.skipIf(!gitPresent)('names the worktree holding a branch', async () => {
    const added = await addWorktree(repo, 'wt-branch')
    expect(added.ok).toBe(true)
    if (!added.ok) return
    const records = await listWorktrees(repo)
    samePath(records.find((r) => r.branch === 'wt-branch')?.path, added.path)
    await removeWorktree(repo, added.path, false)
  })

  it.skipIf(!gitPresent)('says no merge is in progress on a settled repository', async () => {
    expect(await mergeInProgress(repo)).toBe(false)
  })

  it.skipIf(!gitPresent)('sees a conflicted merge, which is what Integrate stops on', async () => {
    // Two branches editing one line: the merge stops half-done, which is
    // exactly the state the panel must refuse to queue another merge behind.
    run(['checkout', '-q', '-b', 'left'])
    writeFileSync(join(repo, 'clash.txt'), 'left\n')
    run(['add', '.'])
    run(['commit', '-qm', 'left'])
    run(['checkout', '-q', 'main'])
    run(['checkout', '-q', '-b', 'right'])
    writeFileSync(join(repo, 'clash.txt'), 'right\n')
    run(['add', '.'])
    run(['commit', '-qm', 'right'])
    try {
      run(['merge', '--no-ff', 'left'])
    } catch {
      // expected: that is the conflict
    }
    expect(await mergeInProgress(repo)).toBe(true)
    run(['merge', '--abort'])
    expect(await mergeInProgress(repo)).toBe(false)
    run(['checkout', '-q', 'main'])
  })

  it.skipIf(!gitPresent)('assembles a tree of worktrees, with the rest of the branches below', async () => {
    const tree = await gitTree(repo)
    expect(tree).not.toBeNull()
    if (tree === null) return
    expect(tree.base).toBe('main')
    expect(tree.mergeInProgress).toBe(false)
    // No remote, so nothing to fetch and nothing to say about GitHub.
    expect(tree.remote).toBeNull()
    expect(tree.lastFetch).toBeNull()

    // The repository's own checkout, first and marked as such.
    const [main] = tree.worktrees
    samePath(main?.path, repo)
    expect(main).toMatchObject({ branch: 'main', isMain: true, dirty: false, prunable: false })

    // Nobody has feature checked out, so it is a branch row and not a worktree.
    expect(tree.worktrees.some((w) => w.branch === 'feature')).toBe(false)
    const feature = tree.branches.find((r) => r.branch === 'feature')
    expect(feature).toMatchObject({ ahead: 2, behind: 0, upstream: null })
  })

  it.skipIf(!gitPresent)('moves a branch into the worktree list once one holds it', async () => {
    const opened = await checkoutWorktree(repo, 'feature')
    expect(opened.ok).toBe(true)
    if (!opened.ok) return
    samePath(opened.path, worktreeDirFor(repo, 'feature'))
    try {
      const tree = await gitTree(repo)
      const row = tree?.worktrees.find((w) => w.branch === 'feature')
      samePath(row?.path, opened.path)
      expect(row).toMatchObject({ isMain: false, ahead: 2, dirty: false, untracked: 0 })
      expect(tree?.branches.some((b) => b.branch === 'feature')).toBe(false)
    } finally {
      await removeWorktree(repo, opened.path, true)
    }
  })

  it.skipIf(!gitPresent)('refuses to check out a branch that does not exist', async () => {
    const result = await checkoutWorktree(repo, 'no-such-branch')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/no-such-branch/)
  })

  it.skipIf(!gitPresent)('reads a detached and a locked worktree', async () => {
    const path = worktreeDirFor(repo, 'detached-one')
    run(['worktree', 'add', '--detach', path, 'main'])
    run(['worktree', 'lock', path])
    try {
      const record = (await listWorktrees(repo)).find((r) => r.branch === null && r.locked)
      expect(record?.head).toMatch(/^[0-9a-f]{40}$/)
      const row = (await gitTree(repo))?.worktrees.find((w) => w.branch === null)
      expect(row).toMatchObject({ locked: true, subject: 'init' })
    } finally {
      run(['worktree', 'unlock', path])
      run(['worktree', 'remove', '--force', path])
    }
  })

  it.skipIf(!gitPresent)('gives nothing at all outside a repository', async () => {
    expect(await gitTree(tempDir('lc-notrepo-'))).toBeNull()
  })
})

describe('parseTrack', () => {
  it.each([
    ['ahead 2, behind 1', { ahead: 2, behind: 1, gone: false }],
    ['ahead 3', { ahead: 3, behind: 0, gone: false }],
    ['behind 4', { ahead: 0, behind: 4, gone: false }],
    ['gone', { ahead: 0, behind: 0, gone: true }],
    // Level with the upstream, or no upstream at all: git prints nothing.
    ['', { ahead: 0, behind: 0, gone: false }]
  ])('reads %j', (text, expected) => {
    expect(parseTrack(text)).toEqual(expected)
  })
})

/**
 * Sync with a remote, against the real binary and a bare repository on disk.
 *
 * A local bare repository stands in for GitHub: it speaks the same protocol to
 * `fetch` and `push`, and a test that needed the network would fail on a plane.
 */
describe('the remote side of the tree, against real git', () => {
  let gitPresent = true
  let origin = ''
  let repo = ''
  let other = ''

  const run = (args: string[], cwd: string): void => {
    execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], {
      cwd,
      stdio: 'ignore'
    })
  }
  const commit = (cwd: string, file: string): void => {
    writeFileSync(join(cwd, file), `${file}\n`)
    run(['add', '.'], cwd)
    run(['commit', '-qm', file], cwd)
  }

  beforeAll(() => {
    try {
      execFileSync('git', ['--version'], { stdio: 'ignore' })
    } catch {
      gitPresent = false
      return
    }
    const base = tempDir('lc-remote-')
    origin = join(base, 'origin.git')
    repo = join(base, 'repo')
    other = join(base, 'other')
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin], { stdio: 'ignore' })
    execFileSync('git', ['init', '-q', '-b', 'main', repo], { stdio: 'ignore' })
    commit(repo, 'a.txt')
    run(['remote', 'add', 'origin', origin], repo)
    run(['push', '-q', '-u', 'origin', 'main'], repo)
    execFileSync('git', ['clone', '-q', origin, other], { stdio: 'ignore' })
  })

  it.skipIf(!gitPresent)('names the remote and starts level with it', async () => {
    const tree = await gitTree(repo)
    expect(tree?.remote).toBe('origin')
    expect(tree?.worktrees[0]).toMatchObject({
      upstream: 'origin/main',
      upstreamAhead: 0,
      upstreamBehind: 0,
      upstreamGone: false
    })
  })

  it.skipIf(!gitPresent)('counts a commit not pushed yet', async () => {
    commit(repo, 'local.txt')
    expect((await gitTree(repo))?.worktrees[0]?.upstreamAhead).toBe(1)
    run(['push', '-q'], repo)
    expect((await gitTree(repo))?.worktrees[0]?.upstreamAhead).toBe(0)
  })

  it.skipIf(!gitPresent)('sees someone else\'s push only after a fetch', async () => {
    run(['pull', '-q'], other)
    commit(other, 'theirs.txt')
    run(['push', '-q'], other)
    // Nothing local knows yet — which is the reason the panel fetches.
    expect((await gitTree(repo))?.worktrees[0]?.upstreamBehind).toBe(0)
    expect(await fetchRemotes(repo)).toEqual({ ok: true })
    const tree = await gitTree(repo)
    expect(tree?.worktrees[0]?.upstreamBehind).toBe(1)
    expect(tree?.lastFetch).not.toBeNull()
  })

  it.skipIf(!gitPresent)('says gone once the remote branch is deleted and pruned', async () => {
    run(['checkout', '-q', '-b', 'topic'], repo)
    commit(repo, 'topic.txt')
    run(['push', '-q', '-u', 'origin', 'topic'], repo)
    run(['checkout', '-q', 'main'], repo)
    execFileSync('git', ['branch', '-D', 'topic'], { cwd: origin, stdio: 'ignore' })
    await fetchRemotes(repo)
    const topic = (await gitTree(repo))?.branches.find((b) => b.branch === 'topic')
    expect(topic?.upstreamGone).toBe(true)
  })

  it.skipIf(!gitPresent)('reports a fetch that cannot reach its remote, without hanging', async () => {
    run(['remote', 'add', 'broken', join(origin, '..', 'nowhere.git')], repo)
    try {
      const result = await fetchRemotes(repo)
      expect(result.ok).toBe(false)
      expect(result.error).toBeTruthy()
    } finally {
      run(['remote', 'remove', 'broken'], repo)
    }
  })

  it.skipIf(!gitPresent)('knows a repository with no remote has none', async () => {
    const lone = join(tempDir('lc-lone-'), 'repo')
    execFileSync('git', ['init', '-q', '-b', 'main', lone], { stdio: 'ignore' })
    commit(lone, 'x.txt')
    expect(await primaryRemote(lone)).toBeNull()
  })
})
