import { describe, expect, it } from 'vitest'
import {
  adoptLegacySquads,
  canDrive,
  carryNodeMeta,
  crewHue,
  crewIdFor,
  crewStatus,
  groupByCrew,
  handleError,
  linkSegments,
  nextHandle,
  normaliseCrews,
  resolveTarget,
  workerSlot
} from './crew'
import type { CrewPane } from './crew'
import type { PaneNode, PaneNodeCrew } from './types'

describe('carryNodeMeta', () => {
  // The bug it was written for: a layout preset dropped every squad role.
  it('carries the role across a reshape, along with the title and folder', () => {
    const before: PaneNode = {
      type: 'pane',
      id: 'p_a',
      name: 'Dev',
      cwd: '/repo',
      role: { id: 'developer', squadDir: '/repo/.squad' }
    }
    const after = carryNodeMeta(before, { type: 'pane', id: 'p_a' })
    expect(after).toEqual(before)
  })

  // A field added to PaneNode later must not need this function updated.
  it('carries fields it was never told about', () => {
    const before = { type: 'pane', id: 'p_a', later: { x: 1 } } as unknown as PaneNode
    const after = carryNodeMeta(before, { type: 'pane', id: 'p_a' })
    expect((after as unknown as { later: unknown }).later).toEqual({ x: 1 })
  })

  it('keeps the new node its own id and type', () => {
    const after = carryNodeMeta({ type: 'pane', id: 'p_old', cwd: '/x' }, { type: 'pane', id: 'p_new' })
    expect(after).toEqual({ type: 'pane', id: 'p_new', cwd: '/x' })
  })

  it('leaves a fresh pane alone when there was nothing before it', () => {
    const fresh: PaneNode = { type: 'pane', id: 'p_new' }
    expect(carryNodeMeta(undefined, fresh)).toEqual({ type: 'pane', id: 'p_new' })
  })

  it('does not touch the node it copies from', () => {
    const before: PaneNode = { type: 'pane', id: 'p_a', name: 'Dev' }
    carryNodeMeta(before, { type: 'pane', id: 'p_b' })
    expect(before).toEqual({ type: 'pane', id: 'p_a', name: 'Dev' })
  })

  it('carries crew and agent across a reshape', () => {
    const before: PaneNode = {
      type: 'pane',
      id: 'p_a',
      crew: { id: 'c', handle: 'dev' },
      agent: 'claude'
    }
    expect(carryNodeMeta(before, { type: 'pane', id: 'p_a' })).toEqual(before)
  })
})

// One window, two orchestras and a plain pane, the shape every test below uses.
const WINDOW: CrewPane[] = [
  { pane: 'p_lead', crew: { id: 'c_a', handle: 'orchestrator', lead: true }, role: 'orchestrator' },
  { pane: 'p_dev', crew: { id: 'c_a', handle: 'developer' }, role: 'developer' },
  { pane: 'p_sec', crew: { id: 'c_a', handle: 'audit' }, role: 'security' },
  { pane: 'p_lead2', crew: { id: 'c_b', handle: 'lead', lead: true } },
  { pane: 'p_dev2', crew: { id: 'c_b', handle: 'developer' } },
  { pane: 'p_plain' }
]

const errorOf = (r: unknown): string => (r as { error: string }).error

describe('resolveTarget', () => {
  it('passes a pane id through untouched', () => {
    expect(resolveTarget('p_whatever', 'p_lead', WINDOW)).toEqual({ panes: ['p_whatever'] })
  })

  it("finds a handle inside the caller's own crew first", () => {
    // Both orchestras have a developer; each lead means its own.
    expect(resolveTarget('@developer', 'p_lead', WINDOW)).toEqual({ panes: ['p_dev'] })
    expect(resolveTarget('@developer', 'p_lead2', WINDOW)).toEqual({ panes: ['p_dev2'] })
  })

  it('falls back to the role when no handle matches', () => {
    expect(resolveTarget('@security', 'p_lead', WINDOW)).toEqual({ panes: ['p_sec'] })
  })

  it('reads handles without caring about case', () => {
    expect(resolveTarget('@Developer', 'p_lead', WINDOW)).toEqual({ panes: ['p_dev'] })
  })

  it("resolves @lead to the caller's own lead", () => {
    expect(resolveTarget('@lead', 'p_dev', WINDOW)).toEqual({ panes: ['p_lead'] })
    expect(resolveTarget('@lead', 'p_dev2', WINDOW)).toEqual({ panes: ['p_lead2'] })
  })

  it('resolves @* to the rest of the crew, never the caller', () => {
    expect(resolveTarget('@*', 'p_lead', WINDOW)).toEqual({ panes: ['p_dev', 'p_sec'] })
  })

  it('refuses @* from a pane in no crew', () => {
    expect(resolveTarget('@*', 'p_plain', WINDOW)).toHaveProperty('error')
  })

  it('refuses a name nobody answers to, and says where to look', () => {
    expect(errorOf(resolveTarget('@nobody', 'p_lead', WINDOW))).toContain('lc ls --crew')
  })

  // Sending to the wrong one of two developers is worse than being asked.
  it('refuses an ambiguous name rather than guessing', () => {
    expect(errorOf(resolveTarget('@developer', 'p_plain', WINDOW))).toContain('p_dev or p_dev2')
    expect(resolveTarget('@lead', 'p_plain', WINDOW)).toHaveProperty('error')
  })

  it('looks outside the crew when the crew has nobody by that name', () => {
    // canDrive is what warns about it; resolution only finds it.
    expect(resolveTarget('@audit', 'p_lead2', WINDOW)).toEqual({ panes: ['p_sec'] })
  })

  it('resolves a unique name for a caller in no crew, or with no pane at all', () => {
    expect(resolveTarget('@audit', 'p_plain', WINDOW)).toEqual({ panes: ['p_sec'] })
    expect(resolveTarget('@audit', undefined, WINDOW)).toEqual({ panes: ['p_sec'] })
  })

  it('refuses a bare @', () => {
    expect(resolveTarget('@', 'p_lead', WINDOW)).toHaveProperty('error')
  })
})

describe('canDrive', () => {
  const lead: PaneNodeCrew = { id: 'c_a', handle: 'orchestrator', lead: true }
  const dev: PaneNodeCrew = { id: 'c_a', handle: 'developer' }
  const other: PaneNodeCrew = { id: 'c_b', handle: 'developer' }
  const check = (fromCrew?: PaneNodeCrew, targetCrew?: PaneNodeCrew, strict = false) =>
    canDrive({ from: 'p_from', fromCrew, target: 'p_to', targetCrew, strict })

  // The optional-feature rule: lc between plain panes behaves exactly as before.
  it('says nothing at all about panes outside every crew', () => {
    expect(check()).toEqual({ allow: true })
    expect(check(undefined, undefined, true)).toEqual({ allow: true })
  })

  it('lets a lead drive its own workers without comment', () => {
    expect(check(lead, dev)).toEqual({ allow: true })
  })

  it('lets workers drive each other without comment', () => {
    expect(check(dev, { id: 'c_a', handle: 'audit' })).toEqual({ allow: true })
  })

  it('warns, and still allows, a worker driving its lead', () => {
    expect(check(dev, lead)).toMatchObject({ allow: true, warning: expect.stringContaining('your lead') })
  })

  it('warns, and still allows, driving another orchestra', () => {
    expect(check(lead, other)).toMatchObject({
      allow: true,
      warning: expect.stringContaining('another orchestra')
    })
  })

  it('warns about a crew member driving a plain pane, and the other way round', () => {
    expect(check(lead, undefined)).toMatchObject({ allow: true, warning: expect.stringContaining('outside') })
    expect(check(undefined, dev)).toMatchObject({
      allow: true,
      warning: expect.stringContaining('not part of')
    })
  })

  it('turns every warning into a refusal when strict', () => {
    expect(check(dev, lead, true)).toMatchObject({ allow: false, error: expect.stringContaining('strict') })
    expect(check(lead, other, true).allow).toBe(false)
    expect(check(undefined, dev, true).allow).toBe(false)
  })

  it('does not refuse what it would not have warned about, even when strict', () => {
    expect(check(lead, dev, true)).toEqual({ allow: true })
  })

  it('has nothing to judge when nobody can say who is asking', () => {
    expect(
      canDrive({ from: undefined, fromCrew: undefined, target: 'p', targetCrew: dev, strict: false })
    ).toEqual({ allow: true })
  })

  it('refuses a caller nobody can name when the crew is strict', () => {
    const v = canDrive({ from: undefined, fromCrew: undefined, target: 'p', targetCrew: dev, strict: true })
    expect(v.allow).toBe(false)
  })

  it('refuses a caller without the token when the crew is strict, even one claiming to be the lead', () => {
    const v = canDrive({ from: 'p_lead', fromCrew: lead, target: 'p', targetCrew: dev, strict: true, unverified: true })
    expect(v.allow).toBe(false)
  })

  it('takes an unverified caller at its word when nothing is strict, as before', () => {
    const v = canDrive({ from: 'p_lead', fromCrew: lead, target: 'p', targetCrew: dev, strict: false, unverified: true })
    expect(v).toEqual({ allow: true })
  })
})

describe('nextHandle', () => {
  it('uses the name as given when it is free', () => {
    expect(nextHandle('developer', [])).toBe('developer')
  })

  it('numbers a second one rather than refusing it', () => {
    expect(nextHandle('developer', ['developer'])).toBe('developer-2')
    expect(nextHandle('developer', ['developer', 'developer-2'])).toBe('developer-3')
  })

  it('folds whatever was typed into something you can put after an @', () => {
    expect(nextHandle('UI / UX', [])).toBe('ui-ux')
    expect(nextHandle('  ', [])).toBe('worker')
  })

  it('compares without caring about case', () => {
    expect(nextHandle('dev', ['DEV'])).toBe('dev-2')
  })

  it('keeps lead for the lead: @lead on a worker would reach the lead instead', () => {
    expect(nextHandle('lead', [])).toBe('lead-2')
    expect(nextHandle('Lead', [], true)).toBe('lead')
  })
})

describe('handleError', () => {
  it('accepts a plain handle and refuses one already taken', () => {
    expect(handleError('dev-2', ['dev'])).toBeNull()
    expect(handleError('dev', ['dev'])).toContain('already')
  })

  it('refuses what a shell would mangle', () => {
    for (const bad of ['Dev', '-dev', 'a b', '', '*']) expect(handleError(bad, [])).not.toBeNull()
  })

  it('refuses lead for a worker but not for the lead', () => {
    expect(handleError('lead', [])).toContain('@lead')
    expect(handleError('lead', [], true)).toBeNull()
    expect(handleError('lead-2', [])).toBeNull()
  })
})

const node = (id: string, crew?: PaneNodeCrew, extra: Partial<PaneNode> = {}): PaneNode => ({
  type: 'pane',
  id,
  ...(crew ? { crew } : {}),
  ...extra
})

describe('normaliseCrews', () => {
  it('leaves a well-formed crew alone', () => {
    const nodes = [node('a', { id: 'c', handle: 'lead', lead: true }), node('b', { id: 'c', handle: 'dev' })]
    const before = JSON.stringify(nodes)
    expect(normaliseCrews(nodes)).toBe(0)
    expect(JSON.stringify(nodes)).toBe(before)
  })

  it('keeps the first lead in reading order and demotes the rest', () => {
    const nodes = [
      node('a', { id: 'c', handle: 'one', lead: true }),
      node('b', { id: 'c', handle: 'two', lead: true })
    ]
    normaliseCrews(nodes)
    expect(nodes[0]!.crew!.lead).toBe(true)
    expect(nodes[1]!.crew!.lead).toBeUndefined()
  })

  it('renames a handle used twice on its second holder', () => {
    const nodes = [
      node('a', { id: 'c', handle: 'lead', lead: true }),
      node('b', { id: 'c', handle: 'dev' }),
      node('d', { id: 'c', handle: 'dev' })
    ]
    normaliseCrews(nodes)
    expect(nodes.map((n) => n.crew!.handle)).toEqual(['lead', 'dev', 'dev-2'])
  })

  it('renames a worker called lead, including a lead it just demoted', () => {
    const nodes = [
      node('a', { id: 'c', handle: 'boss', lead: true }),
      node('b', { id: 'c', handle: 'lead-2' }),
      node('d', { id: 'c', handle: 'lead', lead: true })
    ]
    normaliseCrews(nodes)
    expect(nodes.map((n) => n.crew!.handle)).toEqual(['boss', 'lead-2', 'lead-3'])
  })

  it('gives a member with no usable handle one, from its role when it has one', () => {
    const nodes = [
      node('a', { id: 'c', handle: 'lead', lead: true }),
      node('b', { id: 'c' } as PaneNodeCrew, { role: { id: 'security', squadDir: '/s' } }),
      node('d', { id: 'c', handle: 'Not Valid!' })
    ]
    normaliseCrews(nodes)
    expect(nodes[1]!.crew!.handle).toBe('security')
    expect(nodes[2]!.crew!.handle).toBe('worker')
  })

  it('unlinks a lone worker, and keeps a lone lead', () => {
    const nodes = [node('a', { id: 'c1', handle: 'dev' }), node('b', { id: 'c2', handle: 'lead', lead: true })]
    normaliseCrews(nodes)
    expect(nodes[0]!.crew).toBeUndefined()
    expect(nodes[1]!.crew).toEqual({ id: 'c2', handle: 'lead', lead: true })
  })

  it('keeps a crew whose lead has gone while it still has workers', () => {
    const nodes = [node('a', { id: 'c', handle: 'dev' }), node('b', { id: 'c', handle: 'qa' })]
    expect(normaliseCrews(nodes)).toBe(0)
  })

  it('drops a crew field that is not a crew', () => {
    const nodes = [
      node('a', { handle: 'x' } as unknown as PaneNodeCrew),
      node('b', 'nonsense' as unknown as PaneNodeCrew)
    ]
    normaliseCrews(nodes)
    expect(nodes.every((n) => n.crew === undefined)).toBe(true)
  })

  it('never touches a plain pane', () => {
    const nodes = [node('a', undefined, { name: 'x', cwd: '/r' })]
    expect(normaliseCrews(nodes)).toBe(0)
    expect(nodes[0]).toEqual({ type: 'pane', id: 'a', name: 'x', cwd: '/r' })
  })
})

describe('adoptLegacySquads', () => {
  const squad = (id: string, role: string, squadDir: string): PaneNode =>
    node(id, undefined, { role: { id: role, squadDir } })

  it('turns two squads in one tab into two crews, each led by its orchestrator', () => {
    const nodes = [
      squad('a', 'orchestrator', '/repo/.squads/auth'),
      squad('b', 'developer', '/repo/.squads/auth'),
      squad('c', 'orchestrator', '/repo/.squads/billing'),
      squad('d', 'security', '/repo/.squads/billing'),
      node('e')
    ]
    expect(adoptLegacySquads(nodes)).toBe(4)
    const [a, b, c, d, e] = nodes
    expect(a!.crew).toEqual({ id: crewIdFor('/repo/.squads/auth'), handle: 'orchestrator', lead: true })
    expect(b!.crew).toEqual({ id: crewIdFor('/repo/.squads/auth'), handle: 'developer' })
    expect(c!.crew!.id).toBe(crewIdFor('/repo/.squads/billing'))
    expect(c!.crew!.id).not.toBe(a!.crew!.id)
    expect(d!.crew).toEqual({ id: c!.crew!.id, handle: 'security' })
    expect(e!.crew).toBeUndefined()
  })

  it('joins a pane to the crew its squad already formed', () => {
    const dir = '/repo/.squads/auth'
    const nodes = [
      node('a', { id: crewIdFor(dir), handle: 'orchestrator', lead: true }, {
        role: { id: 'orchestrator', squadDir: dir }
      }),
      node('b', { id: crewIdFor(dir), handle: 'developer' }, { role: { id: 'developer', squadDir: dir } }),
      squad('c', 'developer', dir)
    ]
    expect(adoptLegacySquads(nodes)).toBe(1)
    expect(nodes[2]!.crew).toEqual({ id: crewIdFor(dir), handle: 'developer-2' })
  })

  it('does not hand a second lead to a crew that has one', () => {
    const nodes = [squad('a', 'orchestrator', '/s'), squad('b', 'orchestrator', '/s')]
    adoptLegacySquads(nodes)
    expect(nodes.filter((n) => n.crew?.lead)).toHaveLength(1)
  })

  it('names the same crew for the same folder whichever way its slashes lean', () => {
    expect(crewIdFor('C:\\repo\\.squads\\x')).toBe(crewIdFor('C:/repo/.squads/x'))
  })
})

describe('crewHue', () => {
  it('is a hue, and the same one every time for the same crew', () => {
    const h = crewHue('c_abc')
    expect(h).toBeGreaterThanOrEqual(0)
    expect(h).toBeLessThan(360)
    expect(crewHue('c_abc')).toBe(h)
  })
})

describe('crewStatus', () => {
  it('shows the neediest member', () => {
    expect(crewStatus(['working', 'waiting-approval', 'idle'])).toBe('waiting-approval')
    expect(crewStatus(['working', 'waiting-input'])).toBe('waiting-input')
    expect(crewStatus([undefined, 'working'])).toBe('working')
  })

  it('is idle with nobody, or nobody reporting', () => {
    expect(crewStatus([])).toBe('idle')
    expect(crewStatus([undefined])).toBe('idle')
  })
})

describe('linkSegments', () => {
  const rects = [
    { id: 'lead', x: 0, y: 0, w: 0.5, h: 1 },
    { id: 'w1', x: 0.5, y: 0, w: 0.5, h: 0.5 },
    { id: 'w2', x: 0.5, y: 0.5, w: 0.5, h: 0.5 }
  ]

  it("runs a line from the lead's centre to each worker's", () => {
    const segs = linkSegments(rects, [{ pane: 'lead', lead: true }, { pane: 'w1' }, { pane: 'w2' }])
    expect(segs).toEqual([
      { pane: 'w1', x1: 0.25, y1: 0.5, x2: 0.75, y2: 0.25 },
      { pane: 'w2', x1: 0.25, y1: 0.5, x2: 0.75, y2: 0.75 }
    ])
  })

  it('skips a worker that is not on this screen', () => {
    expect(linkSegments(rects, [{ pane: 'lead', lead: true }, { pane: 'elsewhere' }])).toEqual([])
  })

  it('draws nothing without a lead on screen', () => {
    expect(linkSegments(rects, [{ pane: 'w1' }, { pane: 'w2' }])).toEqual([])
    expect(linkSegments(rects, [{ pane: 'gone', lead: true }, { pane: 'w1' }])).toEqual([])
  })
})

describe('workerSlot', () => {
  it('opens the first worker to the right of the lead', () => {
    expect(workerSlot([{ id: 'lead', x: 0, y: 0, w: 1, h: 1 }], 'lead', [])).toEqual({
      target: 'lead',
      orientation: 'row'
    })
  })

  it('splits the largest worker across its longer side', () => {
    const rects = [
      { id: 'lead', x: 0, y: 0, w: 0.5, h: 1 },
      { id: 'w1', x: 0.5, y: 0, w: 0.5, h: 0.75 },
      { id: 'w2', x: 0.5, y: 0.75, w: 0.5, h: 0.25 }
    ]
    expect(workerSlot(rects, 'lead', ['w1', 'w2'])).toEqual({ target: 'w1', orientation: 'column' })
    expect(workerSlot(rects, 'lead', ['w2'])).toEqual({ target: 'w2', orientation: 'row' })
  })
})

describe('groupByCrew', () => {
  const crewOf = (s: string): string | undefined => (s.includes(':') ? s.split(':')[0] : undefined)

  // Mission Control for somebody with no orchestra must not change at all.
  it('gives a list with no crew back as one plain group, in order', () => {
    expect(groupByCrew(['a', 'b', 'c'], crewOf)).toEqual([{ crew: null, items: ['a', 'b', 'c'] }])
  })

  it('pulls each crew together where its first member was', () => {
    expect(groupByCrew(['x:lead', 'a', 'x:dev', 'y:lead', 'b', 'y:qa'], crewOf)).toEqual([
      { crew: 'x', items: ['x:lead', 'x:dev'] },
      { crew: null, items: ['a'] },
      { crew: 'y', items: ['y:lead', 'y:qa'] },
      { crew: null, items: ['b'] }
    ])
  })

  it('returns nothing for nothing', () => {
    expect(groupByCrew([], crewOf)).toEqual([])
  })
})
