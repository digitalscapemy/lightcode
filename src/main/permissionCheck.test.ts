import { chmodSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))

const { canRewrite, canWriteIn } = await import('./permissionCheck')

describe('permission write tests', () => {
  it('leaves an existing profile exactly as it was: content and modified time', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lc-perm-'))
    const file = join(dir, 'Microsoft.PowerShell_profile.ps1')
    writeFileSync(file, '# mine\r\n')
    const before = statSync(file).mtimeMs
    await new Promise((r) => setTimeout(r, 30))
    expect(canRewrite(file).ok).toBe(true)
    expect(readFileSync(file, 'utf8')).toBe('# mine\r\n')
    expect(statSync(file).mtimeMs).toBe(before)
  })

  it('leaves no probe file behind', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lc-perm-'))
    expect(canWriteIn(dir).ok).toBe(true)
    expect(readdirSync(dir)).toEqual([])
  })

  it('tests the nearest existing folder for a profile folder not made yet', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lc-perm-'))
    expect(canWriteIn(join(dir, 'PowerShell', 'deeper')).ok).toBe(true)
    expect(readdirSync(dir)).toEqual([])
  })

  it('reports a file it may not write, with the reason', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lc-perm-'))
    const file = join(dir, 'profile.ps1')
    writeFileSync(file, 'x')
    chmodSync(file, 0o444)
    try {
      const r = canRewrite(file)
      expect(r.ok).toBe(false)
      expect(r.reason).toMatch(/EPERM|EACCES/)
    } finally {
      chmodSync(file, 0o666)
    }
  })
})
