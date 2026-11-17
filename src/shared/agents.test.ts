import { describe, expect, it } from 'vitest'
import { AGENTS, AGENT_IDS, DEFAULT_AGENT, agentFor, firstMessage } from './agents'

const posix = (p: string): string => `'${p.replace(/'/g, "'\\''")}'`
const windows = (p: string): string => `'${p.replace(/'/g, "''")}'`

describe('the claude adapter', () => {
  const claude = AGENTS.claude!

  // Fan-out and the squad build their command lines through here now; these
  // are the exact lines they typed before the adapter existed.
  it('launches with the prompt as one argument', () => {
    expect(claude.launch('do it', { plan: false, quote: posix })).toBe("claude 'do it'")
    expect(claude.launch("don't", { plan: false, quote: posix })).toBe("claude 'don'\\''t'")
    expect(claude.launch("don't", { plan: false, quote: windows })).toBe("claude 'don''t'")
  })

  it('starts in plan mode when asked', () => {
    expect(claude.launch('do it', { plan: true, quote: posix })).toBe("claude --permission-mode plan 'do it'")
  })

  it('starts empty, with no trailing space, when there is no prompt', () => {
    expect(claude.launch(null, { plan: false, quote: posix })).toBe('claude')
    expect(claude.launch(null, { plan: true, quote: posix })).toBe('claude --permission-mode plan')
  })

  it('gets its role from the wrapper and its status from hooks', () => {
    expect(claude.rolePromptVia).toBe('wrapper')
    expect(claude.status).toBe('hooks')
  })

  it('answers its permission menu with 1 and Esc, and stops a turn with Esc', () => {
    expect(claude.approve).toEqual({ yes: '1', no: '\x1b' })
    expect(claude.interrupt).toBe('\x1b')
  })
})

describe('the codex adapter', () => {
  const codex = AGENTS.codex!

  it('asks before acting, and is read-only in plan mode', () => {
    expect(codex.launch('do it', { plan: false, quote: posix })).toBe("codex -a on-request 'do it'")
    expect(codex.launch('do it', { plan: true, quote: posix })).toBe(
      "codex -s read-only -a on-request 'do it'"
    )
    expect(codex.launch(null, { plan: false, quote: posix })).toBe('codex -a on-request')
  })

  it('quotes for Windows and POSIX shells alike', () => {
    expect(codex.launch("don't", { plan: false, quote: windows })).toBe("codex -a on-request 'don''t'")
    expect(codex.launch("don't", { plan: false, quote: posix })).toBe("codex -a on-request 'don'\\''t'")
  })

  it('takes the role in front of its first message', () => {
    expect(codex.launch('fix it', { plan: false, quote: posix, rolePrompt: 'You review.' })).toBe(
      "codex -a on-request 'You review.\n\nYour task: fix it'"
    )
    expect(codex.launch(null, { plan: false, quote: posix, rolePrompt: 'You review.' })).toBe(
      "codex -a on-request 'You review.\n\nWait for your first task.'"
    )
  })

  it('is watched by the heuristic, stopped with ^C, and never approved for', () => {
    expect(codex.status).toBe('heuristic')
    expect(codex.rolePromptVia).toBe('first-message')
    expect(codex.interrupt).toBe('\x03')
    expect(codex.approve).toBeUndefined()
  })
})

describe('the gemini adapter', () => {
  const gemini = AGENTS.gemini!

  it('opens its interactive session on the prompt', () => {
    expect(gemini.launch('do it', { plan: false, quote: posix })).toBe("gemini -i 'do it'")
    expect(gemini.launch('do it', { plan: true, quote: windows })).toBe("gemini --approval-mode plan -i 'do it'")
    expect(gemini.launch(null, { plan: false, quote: posix })).toBe('gemini')
  })

  it('says it has not been tried', () => {
    expect(gemini.untested).toBe(true)
    expect(gemini.status).toBe('heuristic')
    expect(gemini.approve).toBeUndefined()
  })
})

describe('the shell adapter', () => {
  it('launches nothing and reports nothing', () => {
    const shell = AGENTS.shell!
    expect(shell.launch('npm test', { plan: false, quote: posix })).toBe('')
    expect(shell.launch(null, { plan: true, quote: posix, rolePrompt: 'x' })).toBe('')
    expect(shell.status).toBe('none')
    expect(shell.bin).toBe('')
  })
})

describe('the role prompt', () => {
  it('goes first only for an agent that takes it as a first message', () => {
    // Claude's wrapper re-applies it at every launch; on the command line too
    // it would be said twice, and lost the moment claude restarts anyway.
    expect(AGENTS.claude!.launch('task', { plan: false, quote: posix, rolePrompt: 'Role.' })).toBe(
      "claude 'task'"
    )
    for (const id of AGENT_IDS) {
      const a = AGENTS[id]!
      const line = a.launch('task', { plan: false, quote: posix, rolePrompt: 'Role.' })
      if (a.rolePromptVia === 'first-message' && line !== '') expect(line).toContain('Role.')
      else expect(line).not.toContain('Role.')
    }
  })

  it('leaves the prompt alone when there is no role', () => {
    expect(firstMessage('task', null)).toBe('task')
    expect(firstMessage(null, undefined)).toBeNull()
  })
})

describe('agentFor', () => {
  it('finds an agent by id', () => {
    expect(agentFor('claude').id).toBe('claude')
  })

  // A state file from a later version may name an agent this one never heard of.
  it.each([null, undefined, '', 'some-future-agent'])('falls back to claude for %s', (id) => {
    expect(agentFor(id).id).toBe(DEFAULT_AGENT)
  })

  // Ids come from `lc spawn --agent`; an Object.prototype name is not an agent.
  it.each(['constructor', 'toString', '__proto__', 'hasOwnProperty'])('knows no agent called %s', (id) => {
    expect(AGENTS[id]).toBeUndefined()
    expect(agentFor(id).id).toBe(DEFAULT_AGENT)
  })

  it('lists every id it knows', () => {
    expect([...AGENT_IDS]).toEqual(['claude', 'codex', 'gemini', 'shell'])
    for (const id of AGENT_IDS) expect(AGENTS[id]!.id).toBe(id)
  })
})
