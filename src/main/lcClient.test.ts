import { execFileSync } from 'child_process'
import { Script } from 'vm'
import { describe, expect, it } from 'vitest'
import { lcClientScript, posixLauncher, windowsLauncher } from './lcClient'
import { LC_PROTOCOL } from '../shared/lc'

/** The real one, and the reason quoting is not optional: it has a space in it. */
const ELECTRON = '/Applications/Light Code.app/Contents/MacOS/Light Code'
const SCRIPT = '/Users/x/Library/Application Support/lightclaude/lc/lc.js'

/**
 * The client is a string inside a template literal, which means the compiler
 * never sees it as code. Nothing in the build, the typecheck or the rest of the
 * suite can tell whether what gets written to disk is even parseable — and a
 * script that will not parse is not a degraded `lc`, it is no `lc` at all:
 * every command dies on the same SyntaxError before it reaches the socket.
 *
 * That is exactly what shipped once. A `\n` was written where the template
 * needed `\\n`, so the escape was spent at generation time and a real newline
 * landed in the middle of a single-quoted string. 302 passing tests said
 * nothing, because not one of them had ever read the generated file.
 */
describe('lcClientScript', () => {
  // Compiles without running: the script's last act is to open a socket and
  // exit the process, neither of which belongs in a test run.
  it('generates a script that parses', () => {
    const source = lcClientScript()
    expect(() => new Script(source)).not.toThrow()
  })

  // Guards the test above from passing on an empty string, which would parse
  // perfectly well and prove nothing.
  it('generates the whole client, not a fragment', () => {
    const source = lcClientScript()
    expect(source).toContain("require('net')")
    expect(source).toContain('conn.on(')
    expect(source).toContain(`Protocol ${LC_PROTOCOL}`)
  })

  /**
   * The specific mistake, named. A literal newline inside a quoted string is
   * the one way this template can break the file it writes, and it is invisible
   * in review — the source line looks like every other line around it.
   */
  it('escapes its newlines rather than emitting them', () => {
    const source = lcClientScript()
    const offenders = source
      .split('\n')
      .map((line, i) => ({ line, no: i + 1 }))
      .filter(({ line }) => (line.match(/'/g)?.length ?? 0) % 2 === 1)
      .filter(({ line }) => !line.trimStart().startsWith('//'))
    expect(offenders).toEqual([])
  })
})

/**
 * The launcher is what makes `lc` reachable at all. A shell function was the
 * first attempt and it reached only a human at the prompt — never a child
 * shell, which is where an agent runs everything it runs.
 */
describe('posixLauncher', () => {
  it('quotes an install path with spaces in it', () => {
    const sh = posixLauncher(ELECTRON, SCRIPT)
    expect(sh).toContain(`'${ELECTRON}'`)
    expect(sh).toContain(`'${SCRIPT}'`)
  })

  // Not hypothetical on a Mac: a user account named O'Brien puts an apostrophe
  // in the path to userData, and an unescaped one ends the quoted string.
  it('escapes an apostrophe rather than closing the quote on it', () => {
    const sh = posixLauncher('/Users/o\'brien/Electron', SCRIPT)
    expect(sh).toContain("'/Users/o'\\''brien/Electron'")
  })

  it('forwards its arguments and replaces itself with the client', () => {
    const sh = posixLauncher(ELECTRON, SCRIPT)
    expect(sh).toContain('"$@"')
    // exec, so the client's exit code is the launcher's and no shell lingers
    // between the agent and the process it is waiting on.
    expect(sh).toMatch(/^exec /m)
  })

  // The same guard the client itself gets, for the same reason: this file is
  // assembled as a string, so nothing else would notice if it stopped parsing.
  it.runIf(process.platform !== 'win32')('is a script sh will accept', () => {
    const sh = posixLauncher(ELECTRON, SCRIPT)
    expect(() => execFileSync('sh', ['-n'], { input: sh })).not.toThrow()
  })
})

describe('windowsLauncher', () => {
  it('quotes both paths', () => {
    const cmd = windowsLauncher('C:\\Program Files\\Light Code\\Light Code.exe', SCRIPT)
    expect(cmd).toContain('"C:\\Program Files\\Light Code\\Light Code.exe"')
    expect(cmd).toContain(`"${SCRIPT}"`)
  })

  /**
   * `setlocal` restores the previous ERRORLEVEL at `endlocal`, so a plain
   * `endlocal` would hand back 0 no matter how the client exited. The value has
   * to be read on the same line, where it expands before endlocal runs — and an
   * agent branching on whether `lc wait` succeeded needs it to be the real one.
   */
  it('carries the client exit code back out through endlocal', () => {
    const cmd = windowsLauncher(ELECTRON, SCRIPT)
    expect(cmd).toContain('endlocal & exit /b %ERRORLEVEL%')
  })

  it('uses CRLF, which is what cmd.exe expects of a .cmd', () => {
    const cmd = windowsLauncher(ELECTRON, SCRIPT)
    expect(cmd.split('\n').every((l) => l === '' || l.endsWith('\r'))).toBe(true)
  })
})
