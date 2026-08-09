import { Script } from 'vm'
import { describe, expect, it } from 'vitest'
import { lcClientScript } from './lcClient'
import { LC_PROTOCOL } from '../shared/lc'

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
