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

describe('writing $PROFILE when Windows refuses', () => {
  it.runIf(process.platform === 'win32')(
    'explains a blocked write instead of reporting a raw EPERM',
    async () => {
      const { mkdtempSync, writeFileSync, chmodSync } = await import('fs')
      const { tmpdir } = await import('os')
      const { join } = await import('path')
      const { writeManagedBlock } = await import('./shortcuts')
      const dir = mkdtempSync(join(tmpdir(), 'lc-ro-'))
      const file = join(dir, 'Microsoft.PowerShell_profile.ps1')
      writeFileSync(file, '# mine\r\n')
      chmodSync(file, 0o444) // read-only: rename over it fails with EPERM, like a blocked folder
      try {
        const err = writeManagedBlock(file, "function p { Set-Location -LiteralPath 'C:/x' }")
        expect(err).toMatch(/Controlled folder access/)
        expect(err).toMatch(/No admin rights needed/)
      } finally {
        chmodSync(file, 0o666)
      }
    }
  )

  it('keeps other errors as they are', async () => {
    const { describeWriteError } = await import('./shortcuts')
    const e = Object.assign(new Error('disk full'), { code: 'ENOSPC' })
    expect(describeWriteError('C:\p.ps1', e)).toBe('C:\p.ps1: disk full')
  })
})
