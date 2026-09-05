import { describe, expect, it } from 'vitest'
import { commandFor, rolesFor, squadCost, squadLayoutSpec } from './squad'
import { paneCount } from './layouts'
import { BUILTIN_ROLES } from '../../shared/roles'
import type { Role } from '../../shared/roles'

const ids = BUILTIN_ROLES.map((r) => r.id)

describe('rolesFor', () => {
  it('puts the orchestrator first whatever order it was asked in', () => {
    // Order decides which pane lands in the large slot, and that has to be the
    // pane a person actually talks to.
    const picked = rolesFor(BUILTIN_ROLES, ['security', 'orchestrator', 'developer'])
    expect(picked[0]!.id).toBe('orchestrator')
    expect(picked.map((r) => r.id)).toEqual(['orchestrator', 'developer', 'security'])
  })

  it('ignores ids the project does not define', () => {
    expect(rolesFor(BUILTIN_ROLES, ['developer', 'nope']).map((r) => r.id)).toEqual(['developer'])
  })

  it('returns nothing for an empty pick', () => {
    expect(rolesFor(BUILTIN_ROLES, [])).toEqual([])
  })
})

describe('squadLayoutSpec', () => {
  it('gives one pane per role, orchestrator included', () => {
    for (const workers of [1, 2, 3, 4, 5, 8]) {
      expect(paneCount(squadLayoutSpec(workers))).toBe(workers + 1)
    }
  })

  it('is a single pane when there is nobody to direct', () => {
    expect(squadLayoutSpec(0)).toBe('p')
  })

  it('keeps the orchestrator as the first slot, which buildLayout fills first', () => {
    const spec = squadLayoutSpec(4)
    expect(typeof spec === 'object' && 'row' in spec && spec.row[0]).toBe('p')
  })

  it('splits the workers into two columns once one column stops being readable', () => {
    const four = squadLayoutSpec(4)
    const five = squadLayoutSpec(5)
    // Four stack; five do not — the shape genuinely changes rather than the
    // column simply growing.
    expect(JSON.stringify(four)).not.toBe(JSON.stringify(five))
    expect(paneCount(five)).toBe(6)
  })
})

describe('commandFor', () => {
  const quoted = (p: string): string => `'${p}'`
  const lead = BUILTIN_ROLES.find((r) => r.orchestrator)!
  const dev = BUILTIN_ROLES.find((r) => r.id === 'developer')!

  it('gives the brief to the orchestrator only', () => {
    expect(commandFor(lead, 'add rate limiting', quoted)).toBe("claude 'add rate limiting'")
  })

  it('starts the others empty, waiting to be delegated to', () => {
    // Five agents each independently attacking the same brief is a fan-out,
    // and there is already a button for that.
    expect(commandFor(dev, 'add rate limiting', quoted)).toBe('claude')
  })

  it('honours a role that asks to start in plan mode', () => {
    const planner: Role = { ...dev, plan: true }
    expect(commandFor(planner, 'x', quoted)).toBe('claude --permission-mode plan')
  })

  it('never puts the role brief on the command line', () => {
    // It rides in the environment so it survives the agent restarting claude.
    expect(commandFor(dev, 'x', quoted)).not.toContain('append-system-prompt')
  })
})

describe('squadCost', () => {
  it('names the branches, because they outlive the panes', () => {
    const text = squadCost('auth', rolesFor(BUILTIN_ROLES, ids))
    expect(text).toContain('5 panes')
    expect(text).toContain('auth-developer')
    expect(text).toContain('auth-devops')
  })

  it('says plainly when nothing will be branched', () => {
    const text = squadCost('auth', rolesFor(BUILTIN_ROLES, ['orchestrator', 'security']))
    expect(text).toContain('no new branches')
  })

  it('counts the reviewing roles apart from the writing ones', () => {
    const text = squadCost('auth', rolesFor(BUILTIN_ROLES, ids))
    expect(text).toContain('2 reviewing')
  })
})
