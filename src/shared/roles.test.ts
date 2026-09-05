import { describe, expect, it } from 'vitest'
import {
  BUILTIN_ROLES,
  branchForRole,
  branchesForSquad,
  mergeRoles,
  roleById,
  roleError,
  rolePrompt,
  taskNameError
} from './roles'

const role = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'tester',
  label: 'Tester',
  prompt: 'You test things.',
  writes: false,
  ...over
})

describe('the built-in squad', () => {
  it('has exactly one orchestrator, and it does not write', () => {
    const leads = BUILTIN_ROLES.filter((r) => r.orchestrator)
    expect(leads).toHaveLength(1)
    expect(leads[0]!.writes).toBe(false)
  })

  it('gives branches only to the roles that write code', () => {
    // The whole design: reviewers have nothing to merge, so they cannot conflict.
    const writers = BUILTIN_ROLES.filter((r) => r.writes).map((r) => r.id)
    expect(writers).toEqual(['developer', 'devops'])
  })

  it('every built-in passes the validation an override has to pass', () => {
    for (const r of BUILTIN_ROLES) expect(roleError(r)).toBeNull()
  })

  it('has ids usable as both a branch suffix and a filename', () => {
    for (const r of BUILTIN_ROLES) expect(r.id).toMatch(/^[a-z0-9][a-z0-9-]*$/)
  })
})

describe('branches', () => {
  it('names a writing role\'s branch after the task and the role', () => {
    const dev = BUILTIN_ROLES.find((r) => r.id === 'developer')!
    expect(branchForRole('auth', dev)).toBe('auth-developer')
  })

  it('gives a reviewing role no branch at all', () => {
    const sec = BUILTIN_ROLES.find((r) => r.id === 'security')!
    expect(branchForRole('auth', sec)).toBeNull()
  })

  it('lists only the branches a squad would really create', () => {
    expect(branchesForSquad('auth', BUILTIN_ROLES)).toEqual(['auth-developer', 'auth-devops'])
  })
})

describe('taskNameError', () => {
  it('accepts an ordinary name', () => {
    expect(taskNameError('auth-refactor')).toBeNull()
  })

  it('rejects an empty one with something to do about it', () => {
    expect(taskNameError('  ')).toBe('Give the task a name.')
  })

  it('rejects what git would reject, judged on the generated branch', () => {
    expect(taskNameError('has space')).toMatch(/spaces/)
    expect(taskNameError('-leading')).toMatch(/dash/)
  })
})

describe('roleError', () => {
  it('accepts a well-formed role', () => {
    expect(roleError(role())).toBeNull()
  })

  it('rejects an id that could not be a branch name', () => {
    expect(roleError(role({ id: 'Not Valid' }))).toMatch(/lowercase/)
  })

  it('names the role in the message, so the file is searchable', () => {
    expect(roleError(role({ prompt: '' }))).toContain('"tester"')
  })

  it('requires writes to be stated rather than assumed', () => {
    const missing = role()
    delete missing['writes']
    expect(roleError(missing)).toMatch(/writes/)
  })

  it('refuses an orchestrator that also writes code', () => {
    expect(roleError(role({ orchestrator: true, writes: true }))).toMatch(/delegates/)
  })

  it('rejects things that are not objects at all', () => {
    expect(roleError('developer')).toMatch(/object/)
    expect(roleError(null)).toMatch(/object/)
    expect(roleError(['developer'])).toMatch(/object/)
  })
})

describe('mergeRoles', () => {
  it('keeps the built-ins when there is no override', () => {
    expect(mergeRoles(BUILTIN_ROLES, null)).toEqual({ roles: BUILTIN_ROLES, error: null })
    expect(mergeRoles(BUILTIN_ROLES, undefined).roles).toBe(BUILTIN_ROLES)
  })

  it('replaces rather than merges by id', () => {
    // Merging reads well until someone deletes a role from their file and it
    // comes back, which is the opposite of what deleting a line means.
    const result = mergeRoles(BUILTIN_ROLES, [role()])
    expect(result.error).toBeNull()
    expect(result.roles.map((r) => r.id)).toEqual(['tester'])
  })

  it('accepts both a bare array and a { roles: [...] } wrapper', () => {
    expect(mergeRoles(BUILTIN_ROLES, { roles: [role()] }).roles.map((r) => r.id)).toEqual([
      'tester'
    ])
  })

  it('falls back whole rather than half-applying a bad entry', () => {
    const result = mergeRoles(BUILTIN_ROLES, [role(), role({ id: 'BAD ID' })])
    expect(result.roles).toBe(BUILTIN_ROLES)
    expect(result.error).toMatch(/lowercase/)
  })

  it('refuses duplicate ids, which would collide as branches and filenames', () => {
    const result = mergeRoles(BUILTIN_ROLES, [role(), role()])
    expect(result.roles).toBe(BUILTIN_ROLES)
    expect(result.error).toMatch(/share the id/)
  })

  it('refuses two orchestrators', () => {
    const result = mergeRoles(BUILTIN_ROLES, [
      role({ id: 'one', orchestrator: true }),
      role({ id: 'two', orchestrator: true })
    ])
    expect(result.error).toMatch(/[Oo]nly one role/)
  })

  it('says so rather than silently using the built-ins for an empty list', () => {
    const result = mergeRoles(BUILTIN_ROLES, [])
    expect(result.roles).toBe(BUILTIN_ROLES)
    expect(result.error).toMatch(/no roles/)
  })

  it('rejects a shape that is neither', () => {
    expect(mergeRoles(BUILTIN_ROLES, { developer: {} }).error).toMatch(/array of roles/)
  })

  it('gives a role with no emoji something to render', () => {
    expect(mergeRoles(BUILTIN_ROLES, [role()]).roles[0]!.emoji).toBe('•')
  })
})

describe('rolePrompt', () => {
  it('carries the reporting contract as well as the role brief', () => {
    const dev = BUILTIN_ROLES.find((r) => r.id === 'developer')!
    const prompt = rolePrompt(dev)
    expect(prompt).toContain('$LIGHTCODE_SQUAD_DIR/reports/')
    expect(prompt).toContain('Developer')
    expect(prompt).toContain(dev.prompt)
  })
})

describe('roleById', () => {
  it('finds one, and tolerates a pane with no role', () => {
    expect(roleById(BUILTIN_ROLES, 'devops')?.label).toBe('DevOps')
    expect(roleById(BUILTIN_ROLES, null)).toBeNull()
    expect(roleById(BUILTIN_ROLES, 'nope')).toBeNull()
  })
})
