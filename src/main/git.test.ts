import { execFileSync } from 'child_process'
import { existsSync, mkdtempSync, realpathSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { basename, dirname, join } from 'path'
import { beforeAll, describe, expect, it } from 'vitest'
import { branchNameError } from '../shared/git'
import { addWorktree, gitErrorMessage, gitInfo, removeWorktree, worktreeDirFor } from './git'

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

describe('worktreeDirFor', () => {
  it('puts the worktree beside the repository, never inside it', () => {
    const dir = worktreeDirFor('/work/lightcode', 'auth-fix')
    expect(dir).toBe(join('/work', 'lightcode-auth-fix'))
    expect(dirname(dir)).toBe(dirname('/work/lightcode'))
  })

  // A slash is legal in a branch name but cannot go into a folder name; only the
  // folder flattens, so the branch keeps what was typed.
  it('flattens a slash in the folder name only', () => {
    expect(basename(worktreeDirFor('/work/repo', 'feat/auth'))).toBe('repo-feat-auth')
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
    repo = join(realpathSync(mkdtempSync(join(tmpdir(), 'lc-git-'))), 'repo')
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
    expect(info.root).toBe(repo)
  })

  it.skipIf(!gitPresent)('says nothing at all outside a repository', async () => {
    const info = await gitInfo(realpathSync(mkdtempSync(join(tmpdir(), 'lc-bare-'))))
    expect(info).toEqual({ repo: false, root: null, branch: null, dirty: false, worktree: false })
  })

  it.skipIf(!gitPresent)('notices a tracked file changing', async () => {
    writeFileSync(join(repo, 'a.txt'), 'changed\n')
    expect((await gitInfo(repo)).dirty).toBe(true)
    writeFileSync(join(repo, 'a.txt'), 'hi\n')
    expect((await gitInfo(repo)).dirty).toBe(false)
  })

  // An untracked build directory or stray note is not work in progress, and
  // counting it would leave the marker lit for ever.
  it.skipIf(!gitPresent)('ignores untracked files', async () => {
    writeFileSync(join(repo, 'scratch.txt'), 'note\n')
    expect((await gitInfo(repo)).dirty).toBe(false)
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
    expect(added.path).toBe(worktreeDirFor(repo, 'auth-fix'))
    expect(existsSync(added.path)).toBe(true)

    const inside = await gitInfo(added.path)
    expect(inside).toMatchObject({ repo: true, branch: 'auth-fix', worktree: true })
    // The repository itself must not start calling itself a worktree.
    expect((await gitInfo(repo)).worktree).toBe(false)
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
