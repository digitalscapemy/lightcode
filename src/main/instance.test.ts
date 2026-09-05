import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { atomicWrite, claimOwnership, isPidAlive, ownerPid, releaseOwnership } from './instance'

const dir = (): string => mkdtempSync(join(tmpdir(), 'lc-inst-'))

/**
 * A pid that is certainly not running.
 *
 * Not a small number: pid 1 exists on POSIX and low pids are real on Windows.
 * This is above the default pid_max on Linux and far outside anything Windows
 * hands out in a test run.
 */
const DEAD_PID = 4_194_303

describe('isPidAlive', () => {
  it('knows its own process is running', () => {
    expect(isPidAlive(process.pid)).toBe(true)
  })

  it('reports a pid nothing owns as gone', () => {
    expect(isPidAlive(DEAD_PID)).toBe(false)
  })

  it('treats nonsense as gone rather than throwing', () => {
    expect(isPidAlive(0)).toBe(false)
    expect(isPidAlive(-1)).toBe(false)
    expect(isPidAlive(1.5)).toBe(false)
  })
})

describe('ownerPid', () => {
  it('reads a bare pid', () => {
    expect(ownerPid('1234')).toBe(1234)
  })

  it('reads one behind a prefix', () => {
    expect(ownerPid('lc-1234.sock'.slice(0, -5), 'lc-')).toBe(1234)
  })

  it('refuses anything it did not write', () => {
    // Callers delete whatever this returns a pid for, so a loose match is how a
    // sweep reaches a file it has no business touching.
    expect(ownerPid('spool')).toBeNull()
    expect(ownerPid('012')).toBeNull() // a pid never has a leading zero
    expect(ownerPid('12a')).toBeNull()
    expect(ownerPid('')).toBeNull()
    expect(ownerPid('-5')).toBeNull()
    expect(ownerPid('1234', 'lc-')).toBeNull()
  })
})

describe('atomicWrite', () => {
  it('writes the file', () => {
    const file = join(dir(), 'x.json')
    expect(atomicWrite(file, '{"a":1}')).toBe(true)
    expect(readFileSync(file, 'utf8')).toBe('{"a":1}')
  })

  it('replaces existing content whole', () => {
    const file = join(dir(), 'x.json')
    atomicWrite(file, 'aaaaaaaaaaaaaaaa')
    atomicWrite(file, 'b')
    expect(readFileSync(file, 'utf8')).toBe('b')
  })

  it('leaves no temporary behind, on success or on failure', () => {
    const d = dir()
    atomicWrite(join(d, 'x.json'), 'hi')
    expect(readdirSync(d)).toEqual(['x.json'])

    // A directory where a file should go: the write cannot succeed, and the
    // scratch file must not survive it.
    const bad = join(d, 'sub')
    expect(atomicWrite(join(bad, 'deep', 'y.json'), 'hi')).toBe(false)
    expect(readdirSync(d)).toEqual(['x.json'])
  })
})

describe('claimOwnership', () => {
  it('is granted when nobody holds it', () => {
    const file = join(dir(), 'state.owner')
    expect(claimOwnership(file)).toBe(true)
    expect(readFileSync(file, 'utf8')).toBe(String(process.pid))
  })

  it('is refused while a live process holds it', () => {
    const file = join(dir(), 'state.owner')
    // Any live pid that is not ours. The parent shell will do; failing that,
    // ours is still live and the not-us branch is what is under test.
    writeFileSync(file, String(process.ppid || process.pid))
    if (process.ppid && process.ppid !== process.pid && isPidAlive(process.ppid)) {
      expect(claimOwnership(file)).toBe(false)
    }
  })

  it('is taken over from a process that died', () => {
    // A crash must not cost the next launch its ability to save.
    const file = join(dir(), 'state.owner')
    writeFileSync(file, String(DEAD_PID))
    expect(claimOwnership(file)).toBe(true)
  })

  it('is taken over from a claim nobody can read', () => {
    const file = join(dir(), 'state.owner')
    writeFileSync(file, 'not a pid at all')
    expect(claimOwnership(file)).toBe(true)
  })

  it('is re-granted to the same process', () => {
    const file = join(dir(), 'state.owner')
    expect(claimOwnership(file)).toBe(true)
    expect(claimOwnership(file)).toBe(true)
  })
})

describe('releaseOwnership', () => {
  it('drops our own claim', () => {
    const file = join(dir(), 'state.owner')
    claimOwnership(file)
    releaseOwnership(file)
    expect(existsSync(file)).toBe(false)
  })

  it('never drops somebody else\'s', () => {
    const file = join(dir(), 'state.owner')
    writeFileSync(file, String(DEAD_PID))
    releaseOwnership(file)
    expect(existsSync(file)).toBe(true)
  })

  it('says nothing when there was no claim', () => {
    expect(() => releaseOwnership(join(dir(), 'nothing.owner'))).not.toThrow()
  })
})
