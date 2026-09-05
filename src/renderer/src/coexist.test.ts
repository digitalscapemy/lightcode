import { beforeEach, describe, expect, it } from 'vitest'
import {
  dismissCoexist,
  forgetCoexist,
  isCoexistDismissed,
  sharedRootWarnings
} from './coexist'

const pane = (paneId: string, root: string | null, auto = false): {
  paneId: string
  root: string | null
  auto: boolean
} => ({ paneId, root, auto })

describe('sharedRootWarnings', () => {
  it('says nothing about a pane on its own', () => {
    expect(sharedRootWarnings([pane('a', '/repo', true)]).size).toBe(0)
  })

  it('says nothing when nobody is on auto', () => {
    // Two people working one checkout is a normal day, not a problem to report.
    const warnings = sharedRootWarnings([pane('a', '/repo'), pane('b', '/repo')])
    expect(warnings.size).toBe(0)
  })

  it('warns every pane in the group, not only the automated one', () => {
    // The pane about to be overwritten has as much reason to know as the one
    // doing the overwriting.
    const warnings = sharedRootWarnings([pane('a', '/repo', true), pane('b', '/repo')])
    expect([...warnings.keys()].sort()).toEqual(['a', 'b'])
  })

  it('keeps panes in different roots apart', () => {
    // This is what makes a worktree the answer: moving one pane out clears it.
    const warnings = sharedRootWarnings([
      pane('a', '/repo', true),
      pane('b', '/repo-worktrees/x', true)
    ])
    expect(warnings.size).toBe(0)
  })

  it('ignores panes that are not in a repository at all', () => {
    const warnings = sharedRootWarnings([pane('a', null, true), pane('b', null, true)])
    expect(warnings.size).toBe(0)
  })

  it('warns only the group that has an automated pane', () => {
    const warnings = sharedRootWarnings([
      pane('a', '/one', true),
      pane('b', '/one'),
      pane('c', '/two'),
      pane('d', '/two')
    ])
    expect([...warnings.keys()].sort()).toEqual(['a', 'b'])
  })

  it('names the counts, and the fix, in the sentence', () => {
    const all = sharedRootWarnings([
      pane('a', '/repo', true),
      pane('b', '/repo', true)
    ]).get('a')
    expect(all).toContain('2 auto-mode panes')
    expect(all).toContain('Open Worktree')

    const some = sharedRootWarnings([
      pane('a', '/repo', true),
      pane('b', '/repo'),
      pane('c', '/repo')
    ]).get('a')
    expect(some).toContain('3 panes share this folder, 1 on auto')
  })
})

describe('dismissal', () => {
  beforeEach(() => {
    forgetCoexist('a')
  })

  it('remembers a pane that has been told once', () => {
    expect(isCoexistDismissed('a')).toBe(false)
    dismissCoexist('a')
    expect(isCoexistDismissed('a')).toBe(true)
  })

  it('forgets when the pane goes away, so a reused id starts fresh', () => {
    dismissCoexist('a')
    forgetCoexist('a')
    expect(isCoexistDismissed('a')).toBe(false)
  })
})
