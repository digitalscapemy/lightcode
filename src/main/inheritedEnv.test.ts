import { describe, expect, it } from 'vitest'
import { withoutClaudeSession } from './inheritedEnv'

describe('withoutClaudeSession', () => {
  it("drops an outer Claude Code session's markers and keeps the person's settings", () => {
    const out = withoutClaudeSession({
      PATH: '/bin',
      CLAUDECODE: '1',
      CLAUDE_CODE_CHILD_SESSION: '1',
      CLAUDE_CODE_SESSION_ID: 'abc',
      CLAUDE_CODE_MESSAGING_TOKEN: 'secret',
      CLAUDE_PID: '42',
      CLAUDE_CONFIG_DIR: '/home/me/.claude-1',
      CLAUDE_CODE_GIT_BASH_PATH: 'C:/Git/bin/bash.exe'
    })
    expect(out).toEqual({
      PATH: '/bin',
      CLAUDE_CONFIG_DIR: '/home/me/.claude-1',
      CLAUDE_CODE_GIT_BASH_PATH: 'C:/Git/bin/bash.exe'
    })
  })

  it('matches names case-insensitively, as Windows does', () => {
    expect(withoutClaudeSession({ ClaudeCode: '1', Path: 'x' })).toEqual({ Path: 'x' })
  })
})
