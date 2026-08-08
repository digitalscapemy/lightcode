import { describe, expect, it } from 'vitest'
import { LAYOUT_PRESETS } from './layouts'
import {
  AGENT_COUNTS,
  agentCommand,
  branchNamesFor,
  layoutIdFor,
  quotePrompt,
  taskNameError
} from './fanOut'

describe('branchNamesFor', () => {
  it('numbers one branch per agent', () => {
    expect(branchNamesFor('auth', 3)).toEqual(['auth-1', 'auth-2', 'auth-3'])
  })

  // The numbering has to match the order paneNodes walks, or agent 3 is not the
  // third pane and pointing at one means nothing.
  it('reads in the same order as the panes', () => {
    expect(branchNamesFor('x', 4)[0]).toBe('x-1')
    expect(branchNamesFor('x', 4)[3]).toBe('x-4')
  })
})

describe('taskNameError', () => {
  it.each(['auth-refactor', 'v2', 'feat/login'])('accepts %s', (task) => {
    expect(taskNameError(task)).toBeNull()
  })

  it('asks for a name rather than complaining about a ref', () => {
    expect(taskNameError('')).toMatch(/name/i)
    expect(taskNameError('   ')).toMatch(/name/i)
  })

  // What matters is the branch git will be handed, not the task as typed.
  it.each(['my task', '-x', 'a..b'])('rejects %j because its branch would be rejected', (task) => {
    expect(taskNameError(task)).not.toBeNull()
  })

  // `.lock` is only forbidden at the end of a ref, and the number moves it off
  // the end — so the task is fine even though the bare word would not be.
  it('judges the generated branch, not the bare word', () => {
    expect(taskNameError('thing.lock')).toBeNull()
  })
})

describe('layoutIdFor', () => {
  it.each(AGENT_COUNTS)('has a real preset for %i agents', (count) => {
    const preset = LAYOUT_PRESETS.find((p) => p.id === layoutIdFor(count))
    expect(preset).toBeDefined()
    // A preset with the wrong pane count would leave agents without a pane, or
    // panes without an agent.
    expect(preset?.count).toBe(count)
  })

  it('puts four in a square rather than a row of four', () => {
    expect(layoutIdFor(4)).toBe('4-grid')
  })

  // The counts climb steeply because the cost does; a missing rung would mean a
  // count with no grid, which the loop above would catch as undefined.
  it('offers a decision rather than every number', () => {
    expect([...AGENT_COUNTS]).toEqual([2, 3, 4, 6, 8, 16])
  })
})

describe('agentCommand — plan mode', () => {
  // Three agents rewriting the code is expensive and awkward to compare; three
  // proposing an approach is cheap, touches nothing, and reads side by side.
  it('starts every agent in plan mode when asked', () => {
    expect(agentCommand('do it', false, true)).toBe("claude --permission-mode plan 'do it'")
  })

  it('leaves the command alone otherwise', () => {
    expect(agentCommand('do it', false, false)).toBe("claude 'do it'")
    expect(agentCommand('do it', false)).toBe("claude 'do it'")
  })

  it('keeps the prompt one argument, whichever mode', () => {
    expect(agentCommand("don't", false, true)).toBe(
      "claude --permission-mode plan 'don'\\''t'"
    )
  })
})

describe('quotePrompt', () => {
  it('wraps an ordinary sentence so the shell sees one argument', () => {
    expect(quotePrompt('Refactor the auth module', false)).toBe("'Refactor the auth module'")
  })

  // paths.ts rejects a double quote outright, because in a path it means
  // something is spoofing one. In a prompt it is punctuation.
  it('keeps a double quote, which a path never would', () => {
    expect(quotePrompt('say "hi"', false)).toBe(`'say "hi"'`)
  })

  it('splices a single quote out and back in, POSIX style', () => {
    expect(quotePrompt("don't", false)).toBe("'don'\\''t'")
  })

  it('doubles a single quote instead, PowerShell style', () => {
    expect(quotePrompt("don't", true)).toBe("'don''t'")
  })

  // A newline would end the command line, submitting half a prompt and leaving
  // the rest to run as a command of its own.
  it('flattens newlines rather than letting them submit', () => {
    expect(quotePrompt('first\nsecond', false)).toBe("'first second'")
    expect(quotePrompt('a\r\nb', false)).toBe("'a b'")
  })

  it('trims, so a stray trailing space does not reach the agent', () => {
    expect(quotePrompt('  hi  ', false)).toBe("'hi'")
  })
})

describe('agentCommand', () => {
  it('passes the prompt as an argument rather than typing it afterwards', () => {
    expect(agentCommand('do the thing', false)).toBe("claude 'do the thing'")
  })

  // Typing the prompt after Claude opens would mean guessing when it is ready,
  // and that guess is the bug this app keeps having to remove.
  it('is a single command line, with nothing to send later', () => {
    expect(agentCommand('x', false)).not.toContain('\n')
    expect(agentCommand('x', false)).not.toContain('\r')
  })
})
