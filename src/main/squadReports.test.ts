import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import {
  REPORT_READ_CAP,
  SquadReports,
  changedReports,
  debounce,
  reportNameOk,
  squadDirAllowed
} from './squadReports'
import type { SquadReportUpdate } from '../shared/ipc'

const isWindows = process.platform === 'win32'
const root = isWindows ? 'C:\\Projects' : '/home/me'
const sep = isWindows ? '\\' : '/'
const p = (...parts: string[]): string => [root, ...parts].join(sep)

describe('squadDirAllowed', () => {
  const none = new Set<string>()

  it('allows the shape prepareSquad makes', () => {
    expect(squadDirAllowed(p('app-worktrees', 'auth-squad'), none)).toBe(true)
    expect(squadDirAllowed(p('app-worktrees', 'c_1x2y-squad'), none)).toBe(true)
  })

  it('refuses anything else unless prepareSquad handed it out', () => {
    const home = p('me')
    expect(squadDirAllowed(home, none)).toBe(false)
    expect(squadDirAllowed(p('app'), none)).toBe(false)
    expect(squadDirAllowed(p('app-worktrees', 'feature'), none)).toBe(false)
    expect(squadDirAllowed(p('elsewhere', 'auth-squad'), none)).toBe(false)
    const granted = new Set([isWindows ? home.toLowerCase() : home])
    expect(squadDirAllowed(home, granted)).toBe(true)
  })

  it('refuses relative paths, parent steps and non-strings', () => {
    expect(squadDirAllowed('app-worktrees/auth-squad', none)).toBe(false)
    expect(squadDirAllowed(p('app-worktrees', 'auth-squad', '..', '..', 'x-worktrees', 'y-squad'), none)).toBe(
      false
    )
    expect(squadDirAllowed(42, none)).toBe(false)
    expect(squadDirAllowed('', none)).toBe(false)
    expect(squadDirAllowed(`${p('app-worktrees', 'auth-squad')}\0`, none)).toBe(false)
  })
})

describe('reportNameOk', () => {
  it('takes <role id>.md only', () => {
    expect(reportNameOk('developer.md')).toBe(true)
    expect(reportNameOk('code-reviewer.md')).toBe(true)
    expect(reportNameOk('../secret.md')).toBe(false)
    expect(reportNameOk('sub/developer.md')).toBe(false)
    expect(reportNameOk('sub\\developer.md')).toBe(false)
    expect(reportNameOk('.hidden.md')).toBe(false)
    expect(reportNameOk('Developer.md')).toBe(false)
    expect(reportNameOk('developer.txt')).toBe(false)
    expect(reportNameOk('.md')).toBe(false)
    expect(reportNameOk(null)).toBe(false)
  })
})

describe('changedReports', () => {
  it('names new and rewritten reports, not untouched ones', () => {
    const seen = new Map([
      ['a.md', '10:1000'],
      ['b.md', '20:2000']
    ])
    const now = [
      { name: 'a.md', size: 10, mtime: 1000 },
      { name: 'b.md', size: 20, mtime: 2500 },
      { name: 'c.md', size: 5, mtime: 3000 }
    ]
    expect(changedReports(seen, now)).toEqual(['b.md', 'c.md'])
  })

  it('counts a same-time rewrite at a new length', () => {
    expect(changedReports(new Map([['a.md', '10:1000']]), [{ name: 'a.md', size: 11, mtime: 1000 }])).toEqual([
      'a.md'
    ])
  })
})

describe('debounce', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('folds a burst into one call, after the quiet', () => {
    vi.useFakeTimers()
    const fn = vi.fn()
    const kick = debounce(fn, 300)
    kick()
    vi.advanceTimersByTime(200)
    kick()
    vi.advanceTimersByTime(200)
    kick()
    expect(fn).not.toHaveBeenCalled()
    vi.advanceTimersByTime(300)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('cancel drops the pending call', () => {
    vi.useFakeTimers()
    const fn = vi.fn()
    const kick = debounce(fn, 300)
    kick()
    kick.cancel()
    vi.advanceTimersByTime(1000)
    expect(fn).not.toHaveBeenCalled()
  })
})

describe('SquadReports', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'lc-reports-'))
  const squad = join(tmp, 'app-worktrees', 'auth-squad')
  const reports = join(squad, 'reports')
  mkdirSync(reports, { recursive: true })
  writeFileSync(join(reports, 'developer.md'), '# Done\n\nAll tests pass.')
  writeFileSync(join(reports, 'notes.txt'), 'not a report')
  writeFileSync(join(tmp, 'outside.md'), 'secret')

  afterAll(() => rmSync(tmp, { recursive: true, force: true }))

  const make = (): { r: SquadReports; sent: SquadReportUpdate[] } => {
    const sent: SquadReportUpdate[] = []
    const r = new SquadReports()
    r.setTarget({ send: (_ch: string, u: SquadReportUpdate) => sent.push(u), isDestroyed: () => false } as never)
    return { r, sent }
  }

  it('lists only reports, and refuses a folder that is not a squad', async () => {
    const { r } = make()
    expect((await r.watch(squad))?.map((f) => f.name)).toEqual(['developer.md'])
    expect(await r.watch(tmp)).toBeNull()
    expect(r.watching()).toBe(1)
    r.stopAll()
  })

  it('counts watchers, and stops with the last', async () => {
    const { r } = make()
    await r.watch(squad)
    await r.watch(squad)
    r.unwatch(squad)
    expect(r.watching()).toBe(1)
    r.unwatch(squad)
    expect(r.watching()).toBe(0)
  })

  it('keeps an unwatch that arrives while its watch is still being set up', async () => {
    const { r } = make()
    const pending = r.watch(squad)
    r.unwatch(squad)
    expect((await pending)?.map((f) => f.name)).toEqual(['developer.md'])
    expect(r.watching()).toBe(0)

    // Two watches racing, one let go of early: one ref is left, and one unwatch ends it.
    const a = r.watch(squad)
    const b = r.watch(squad)
    r.unwatch(squad)
    await Promise.all([a, b])
    expect(r.watching()).toBe(1)
    r.unwatch(squad)
    expect(r.watching()).toBe(0)
  })

  it('does not let a watch that stopAll overtook set itself up', async () => {
    const { r } = make()
    const stale = r.watch(squad)
    r.stopAll() // the page reloaded
    const fresh = r.watch(squad)
    await Promise.all([stale, fresh])
    expect(r.watching()).toBe(1)
    r.unwatch(squad)
    expect(r.watching()).toBe(0)
  })

  it('pushes a new report, and only once for an unchanged one', async () => {
    const { r, sent } = make()
    await r.watch(squad)
    await r.rescan(squad)
    expect(sent).toHaveLength(0)
    writeFileSync(join(reports, 'tester.md'), 'flaky test found')
    await r.rescan(squad)
    expect(sent).toHaveLength(1)
    expect(sent[0]?.changed).toEqual(['tester.md'])
    expect(sent[0]?.reports.map((f) => f.name)).toEqual(['developer.md', 'tester.md'])
    await r.rescan(squad)
    expect(sent).toHaveLength(1)
    rmSync(join(reports, 'tester.md'))
    await r.rescan(squad)
    expect(sent).toHaveLength(2)
    expect(sent[1]?.changed).toEqual([])
    r.stopAll()
  })

  it('reads a report, and nothing outside the folder', async () => {
    const { r } = make()
    const got = await r.read(squad, 'developer.md')
    expect(got?.text).toBe('# Done\n\nAll tests pass.')
    expect(got?.truncated).toBe(false)
    expect(await r.read(squad, '../../../outside.md')).toBeNull()
    expect(await r.read(squad, 'notes.txt')).toBeNull()
    expect(await r.read(tmp, 'outside.md')).toBeNull()
    expect(await r.read(squad, 'missing.md')).toBeNull()
  })

  it('cuts a large report off at the cap, and says so', async () => {
    const { r } = make()
    writeFileSync(join(reports, 'big.md'), 'x'.repeat(REPORT_READ_CAP + 100))
    const got = await r.read(squad, 'big.md')
    expect(got?.text.length).toBe(REPORT_READ_CAP)
    expect(got?.truncated).toBe(true)
    rmSync(join(reports, 'big.md'))
  })

  // Creating a symlink needs admin rights (or developer mode) on Windows.
  it.skipIf(isWindows)('will not follow a link out of the folder', async () => {
    const { r } = make()
    symlinkSync(join(tmp, 'outside.md'), join(reports, 'link.md'))
    expect(await r.read(squad, 'link.md')).toBeNull()
    rmSync(join(reports, 'link.md'))
  })
})
