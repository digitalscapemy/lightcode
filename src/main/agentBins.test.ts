import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { onPath } from './agentBins'

const has =
  (...files: string[]) =>
  (file: string): boolean =>
    files.map((f) => f.toLowerCase()).includes(file.toLowerCase())

describe('onPath', () => {
  it('finds a command in a PATH folder', () => {
    const exists = has(join('/usr/bin', 'codex'))
    expect(onPath('codex', { path: '/bin:/usr/bin', platform: 'linux', exists })).toBe(true)
    expect(onPath('gemini', { path: '/bin:/usr/bin', platform: 'linux', exists })).toBe(false)
  })

  it('looks in the extra folders a GUI app may lack', () => {
    const exists = has(join('/opt/homebrew/bin', 'codex'))
    expect(onPath('codex', { path: '/usr/bin', platform: 'darwin', extra: ['/opt/homebrew/bin'], exists })).toBe(
      true
    )
  })

  it('finds a Windows command by its PATHEXT extension, or as an npm .ps1', () => {
    const dir = 'C:\\Users\\me\\AppData\\Roaming\\npm'
    const path = `C:\\Windows;${dir}`
    expect(onPath('codex', { path, pathext: '.EXE;.CMD', platform: 'win32', exists: has(join(dir, 'codex.cmd')) })).toBe(
      true
    )
    expect(onPath('codex', { path, pathext: '.EXE', platform: 'win32', exists: has(join(dir, 'codex.ps1')) })).toBe(true)
    expect(onPath('codex', { path, pathext: '.EXE', platform: 'win32', exists: has(join(dir, 'codex.js')) })).toBe(false)
  })

  it('takes a command with no name to be always there', () => {
    // The shell adapter starts nothing, so it can never be missing.
    expect(onPath('', { path: '', platform: 'linux', exists: () => false })).toBe(true)
  })

  it('skips empty PATH entries', () => {
    const seen: string[] = []
    onPath('x', {
      path: '::/a:',
      platform: 'linux',
      exists: (f) => {
        seen.push(f)
        return false
      }
    })
    expect(seen).toEqual([join('/a', 'x')])
  })
})
