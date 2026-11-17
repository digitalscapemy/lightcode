import { describe, expect, it } from 'vitest'
import { commandFor, roleAgent, rolesFor, squadCost, squadLayoutSpec, squadNodes } from './squad'
import { buildLayout, paneCount } from './layouts'
import { paneNodes } from './splitTree'
import { crewIdFor, normaliseCrews } from '../../shared/crew'
import { BUILTIN_ROLES, rolePrompt } from '../../shared/roles'
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

  it('tells an agent with no wrapper its role in its first message', () => {
    expect(commandFor(dev, 'x', quoted, 'codex')).toBe(
      `codex -a on-request '${rolePrompt(dev)}\n\nWait for your first task.'`
    )
    expect(commandFor(lead, 'ship it', quoted, 'codex')).toBe(
      `codex -a on-request '${rolePrompt(lead)}\n\nYour task: ship it'`
    )
  })

  it('types nothing for a role played by a shell', () => {
    expect(commandFor(dev, 'x', quoted, 'shell')).toBe('')
  })

  it('plays a role with the agent roles.json names for it', () => {
    expect(commandFor({ ...dev, agent: 'gemini' }, 'x', quoted)).toMatch(/^gemini -i /)
  })
})

describe('roleAgent', () => {
  const dev = BUILTIN_ROLES.find((r) => r.id === 'developer')!

  it('is Claude unless something says otherwise', () => {
    expect(roleAgent(dev)).toBe('claude')
  })

  it('takes the dialog over the role, and the role over the default', () => {
    expect(roleAgent({ ...dev, agent: 'gemini' })).toBe('gemini')
    expect(roleAgent({ ...dev, agent: 'gemini' }, { developer: 'codex' })).toBe('codex')
  })

  it('ignores an agent nobody knows', () => {
    expect(roleAgent({ ...dev, agent: 'nope' }, { developer: 'constructor' })).toBe('claude')
  })

  it('lets the dialog choose Claude for a role roles.json gives to another agent', () => {
    const role = { ...dev, agent: 'codex' }
    const agent = roleAgent(role, { developer: 'claude' })
    expect(agent).toBe('claude')
    expect(commandFor(role, 'x', (p) => `'${p}'`, agent)).toBe('claude')
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

describe('squadNodes', () => {
  const chosen = rolesFor(BUILTIN_ROLES, ['orchestrator', 'developer', 'security'])
  const fresh = (): ReturnType<typeof paneNodes> => {
    let n = 0
    return paneNodes(buildLayout(squadLayoutSpec(chosen.length - 1), () => `p_${n++}`))
  }
  const opts = {
    cwd: '/repo',
    squadDir: '/repo/.squads/auth',
    worktreeFor: new Map([['developer', '/repo-auth-developer']])
  }

  it('makes the squad one crew, led by the orchestrator in the large slot', () => {
    const nodes = fresh()
    squadNodes(nodes, chosen, opts)
    const id = crewIdFor(opts.squadDir)
    expect(nodes.map((n) => n.crew)).toEqual([
      { id, handle: 'orchestrator', lead: true },
      { id, handle: 'developer' },
      { id, handle: 'security' }
    ])
  })

  it('keeps the role and the folder each pane had before crews', () => {
    const nodes = fresh()
    squadNodes(nodes, chosen, opts)
    expect(nodes.map((n) => [n.role?.id, n.cwd])).toEqual([
      ['orchestrator', '/repo'],
      ['developer', '/repo-auth-developer'],
      ['security', '/repo']
    ])
    expect(nodes.every((n) => n.role?.squadDir === opts.squadDir)).toBe(true)
  })

  it('pairs each stamped node with its role', () => {
    const stamped = squadNodes(fresh(), chosen, opts)
    expect(stamped.map((s) => [s.node.id, s.role.id])).toEqual([
      ['p_0', 'orchestrator'],
      ['p_1', 'developer'],
      ['p_2', 'security']
    ])
  })

  it('takes a crew id of its own when told to', () => {
    const nodes = fresh()
    squadNodes(nodes, chosen, { ...opts, crewId: 'c_new' })
    expect(nodes.every((n) => n.crew?.id === 'c_new')).toBe(true)
  })

  it('leaves nothing for normaliseCrews to repair', () => {
    const nodes = fresh()
    squadNodes(nodes, chosen, opts)
    expect(normaliseCrews(nodes)).toBe(0)
  })

  it('names no agent, so a squad pane launches exactly as it did', () => {
    const nodes = fresh()
    squadNodes(nodes, chosen, opts)
    expect(nodes.every((n) => n.agent === undefined)).toBe(true)
  })

  it('names the agent of a role played by another', () => {
    const nodes = fresh()
    squadNodes(nodes, chosen, { ...opts, agents: { developer: 'codex', security: 'claude' } })
    expect(nodes.map((n) => n.agent)).toEqual([undefined, 'codex', undefined])
  })
})
