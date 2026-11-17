import { describe, expect, it } from 'vitest'
import { providerOf, psAccountBody, shAccountBody } from './accountProviders'
import { toolsFor } from './tools'

describe('providerOf', () => {
  it('reads entries saved before providers existed as Claude', () => {
    expect(providerOf({})).toBe('claude')
    expect(providerOf({ provider: 'codex' })).toBe('codex')
    expect(providerOf({ provider: 'nope' as never })).toBe('claude')
  })
})

describe('account function bodies', () => {
  it('keeps the Claude line exactly as before, so saved profiles do not churn', () => {
    expect(psAccountBody('claude', "'C:\\a'")).toBe("$env:CLAUDE_CONFIG_DIR = 'C:\\a'; & claude @args")
    expect(shAccountBody('claude', "'/a'")).toBe(`CLAUDE_CONFIG_DIR='/a' claude "$@";`)
  })

  it('restores what Codex and Antigravity change in PowerShell', () => {
    const codex = psAccountBody('codex', "'C:\\c'")
    expect(codex).toContain("$env:CODEX_HOME = 'C:\\c'")
    expect(codex).toContain('finally { $env:CODEX_HOME = $o }')
    const agy = psAccountBody('antigravity', "'C:\\g'")
    expect(agy).toContain('& agy @args')
    expect(agy).toContain('finally { $env:USERPROFILE = $o; $env:HOME = $h }')
  })

  it('sets the variable for one command only in POSIX shells', () => {
    expect(shAccountBody('codex', "'/c'")).toBe(`CODEX_HOME='/c' codex "$@";`)
    expect(shAccountBody('antigravity', "'/g'")).toBe(`HOME='/g' agy "$@";`)
  })
})

describe('toolsFor', () => {
  it('offers WSL on Windows only', () => {
    expect(toolsFor('win32').map((t) => t.id)).toContain('wsl')
    expect(toolsFor('darwin').map((t) => t.id)).not.toContain('wsl')
    expect(toolsFor('linux', 'system').map((t) => t.id)).toEqual(['docker'])
  })

  it('splits agents from system tools', () => {
    expect(toolsFor('win32', 'agent').map((t) => t.id)).toEqual(['claude', 'codex', 'antigravity'])
  })
})
