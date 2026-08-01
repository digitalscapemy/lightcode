import { afterEach, describe, expect, it, vi } from 'vitest'
import { shellArg, shellArgs } from './paths'

/** shellArg reads the platform per call, so a stub per test is enough. */
function on(platform: string): void {
  vi.stubGlobal('window', { lightclaude: { platform } })
}

afterEach(() => vi.unstubAllGlobals())

describe('shellArg — POSIX', () => {
  it('leaves a plain path bare, the way dragging into Terminal does', () => {
    on('darwin')
    expect(shellArg('/Users/me/Desktop/lightcode')).toBe('/Users/me/Desktop/lightcode')
  })

  it('quotes a path with spaces', () => {
    on('darwin')
    expect(shellArg('/Users/me/My Notes')).toBe("'/Users/me/My Notes'")
  })

  it.each([
    ['$ (expansion)', '/tmp/$HOME'],
    ['& (background)', '/tmp/a&b'],
    ['; (separator)', '/tmp/a;b'],
    ['` (substitution)', '/tmp/a`id`'],
    ['* (glob)', '/tmp/a*'],
    ['~ (home expansion)', '~/notes'],
    ['( (subshell)', '/tmp/a(1)']
  ])('quotes %s rather than letting the shell act on it', (_name, path) => {
    on('darwin')
    expect(shellArg(path)).toBe(`'${path}'`)
  })

  it("escapes an embedded ' so the quoting can't be broken out of", () => {
    on('darwin')
    // rm -rf ~ stays inside the quotes, as an argument — not as a command.
    expect(shellArg("/tmp/it's; rm -rf ~")).toBe("'/tmp/it'\\''s; rm -rf ~'")
  })
})

describe('shellArg — Windows', () => {
  it('leaves a plain path bare', () => {
    on('win32')
    expect(shellArg('C:\\Users\\me\\lightcode')).toBe('C:\\Users\\me\\lightcode')
  })

  it('quotes a path with spaces', () => {
    on('win32')
    expect(shellArg('C:\\Users\\me\\My Project')).toBe('"C:\\Users\\me\\My Project"')
  })

  it('quotes PowerShell metacharacters that POSIX would have read literally', () => {
    on('win32')
    expect(shellArg('C:\\a,b')).toBe('"C:\\a,b"')
    expect(shellArg('C:\\a@b')).toBe('"C:\\a@b"')
  })

  it('rejects a path containing a quote — illegal in a real path, so spoofed', () => {
    on('win32')
    expect(shellArg('C:\\a" & calc.exe & "')).toBeNull()
  })
})

describe.each(['darwin', 'win32'])('shellArg — control chars (%s)', (platform) => {
  it.each([
    ['CR', '/tmp/a\rwhoami'],
    ['LF', '/tmp/a\nwhoami'],
    ['NUL', '/tmp/a\0b']
  ])('rejects %s, which would submit the line', (_name, path) => {
    on(platform)
    expect(shellArg(path)).toBeNull()
  })
})

describe('shellArgs', () => {
  it('joins a multi-file drop into separate arguments', () => {
    on('darwin')
    expect(shellArgs(['/tmp/a.txt', '/tmp/b c.txt'])).toBe("/tmp/a.txt '/tmp/b c.txt'")
  })

  it('drops the unusable ones and keeps the rest', () => {
    on('darwin')
    expect(shellArgs(['/tmp/a\nb', '/tmp/ok'])).toBe('/tmp/ok')
  })

  it('is empty when nothing survives, so callers can bail on falsy', () => {
    on('darwin')
    expect(shellArgs(['/tmp/a\nb'])).toBe('')
    expect(shellArgs([])).toBe('')
  })
})
