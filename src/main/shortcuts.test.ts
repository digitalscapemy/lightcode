import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '' } }))

const { profilePolicyWarning, psStartupShortcuts } = await import('./shortcuts')

describe('psStartupShortcuts', () => {
  it('defines path and account shortcuts as global functions on one line', () => {
    const line = psStartupShortcuts({
      version: 1,
      paths: [{ name: 'proj', path: "C:\\Work\\Bob's app" }],
      accounts: [{ name: 'cwork', configDir: 'C:\\Users\\me\\.claude-work' }]
    })
    expect(line).toBe(
      "function global:proj { Set-Location -LiteralPath 'C:\\Work\\Bob''s app' }; " +
        "function global:cwork { $env:CLAUDE_CONFIG_DIR = 'C:\\Users\\me\\.claude-work'; & claude @args }"
    )
    expect(line).not.toContain('\n')
    expect(line).not.toContain('#')
  })

  it('skips names that could inject code or would never run', () => {
    const line = psStartupShortcuts({
      version: 1,
      paths: [
        { name: 'x; Remove-Item C:\\ -Recurse', path: 'C:\\a' },
        { name: 'cd', path: 'C:\\b' },
        { name: 'ok', path: '' },
        { name: 'good', path: 'C:\\c' }
      ],
      accounts: [{ name: '$(evil)', configDir: 'C:\\d' }]
    })
    expect(line).toBe("function global:good { Set-Location -LiteralPath 'C:\\c' }")
  })

  it('is empty when there is nothing to define', () => {
    expect(psStartupShortcuts({ version: 1, paths: [], accounts: [] })).toBe('')
  })
})

describe('profilePolicyWarning', () => {
  it('warns when the policy stops $PROFILE from loading', () => {
    for (const p of ['Restricted', 'AllSigned', 'Undefined']) {
      expect(profilePolicyWarning(p)).toMatch(/Set-ExecutionPolicy -Scope CurrentUser RemoteSigned/)
    }
    expect(profilePolicyWarning('Undefined')).toMatch(/is Restricted/)
  })

  it('stays quiet when the profile loads or the policy is unknown', () => {
    for (const p of ['RemoteSigned', 'Unrestricted', 'Bypass', null]) {
      expect(profilePolicyWarning(p)).toBeNull()
    }
  })
})
