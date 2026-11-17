import { describe, expect, it } from 'vitest'
import { fuzzyRank, fuzzyScore } from './fuzzy'

describe('fuzzyScore', () => {
  it('matches characters in order, and only in order', () => {
    expect(fuzzyScore('sr', 'Split right')).not.toBeNull()
    expect(fuzzyScore('rs', 'Split right')).toBeNull()
    expect(fuzzyScore('xyz', 'Split right')).toBeNull()
  })

  it('treats an empty query as a match for everything', () => {
    expect(fuzzyScore('  ', 'anything')).toBe(0)
  })

  it('prefers a substring at a word start', () => {
    expect(fuzzyScore('fan', 'Fan-out')!).toBeGreaterThan(fuzzyScore('fan', 'Elephant fanclub')!)
  })
})

describe('fuzzyRank', () => {
  const cmds = ['Split right', 'Split down', 'Fan-out: one task, several agents', 'Mission Control', 'Worktrees panel']
  const rank = (q: string): string[] => fuzzyRank(q, cmds, (c) => [c])

  it('puts the obvious command first', () => {
    expect(rank('fan')[0]).toBe('Fan-out: one task, several agents')
    expect(rank('mission')[0]).toBe('Mission Control')
    expect(rank('sd')[0]).toBe('Split down')
    expect(rank('work')[0]).toBe('Worktrees panel')
  })

  it('drops what does not match and keeps everything for an empty query', () => {
    expect(rank('zzz')).toEqual([])
    expect(rank('')).toEqual(cmds)
  })

  it('searches keywords as well as titles, ranking titles higher', () => {
    const items = [
      { t: 'Worktrees panel', k: 'git tree branches' },
      { t: 'Git commit helper', k: '' }
    ]
    const r = fuzzyRank('git', items, (i) => [i.t, i.k])
    expect(r.map((i) => i.t)).toEqual(['Git commit helper', 'Worktrees panel'])
  })
})
