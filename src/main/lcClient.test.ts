import { execFileSync } from 'child_process'
import { Script, createContext } from 'vm'
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

/** What the generated client did when run: its exit code, output and request. */
interface ClientRun {
  code: number
  out: string
  err: string
  sent: Record<string, unknown> | null
}

class Exited {
  constructor(public code: number) {}
}

/**
 * Run the generated client for real, against a socket that is not one.
 *
 * Parsing proves the file is a script; this proves it is the right script —
 * that it carries the token, reads stdin, and leaves the exit code an agent
 * branches on. `net` and `fs` are stood in for, and process.exit throws so the
 * script stops where the real one would.
 */
function runClient(
  args: string[],
  o: {
    env?: Record<string, string>
    reply?: Record<string, unknown>
    stdin?: string
    connectError?: boolean
  } = {}
): ClientRun {
  const out: string[] = []
  const err: string[] = []
  let sent: string | null = null
  let code: number | null = null
  let connected = false
  const handlers: Record<string, (arg?: unknown) => void> = {}
  const conn = {
    on(ev: string, fn: (arg?: unknown) => void) {
      handlers[ev] = fn
      return conn
    },
    write(data: string) {
      sent = data
    },
    setEncoding() {}
  }
  const context = createContext({
    require: (mod: string) => {
      if (mod === 'net') {
        return {
          connect: () => {
            connected = true
            return conn
          }
        }
      }
      if (mod === 'fs') {
        return {
          readFileSync: () => {
            if (o.stdin === undefined) throw new Error('no stdin')
            return o.stdin
          }
        }
      }
      throw new Error(`unexpected require: ${mod}`)
    },
    process: {
      argv: ['electron', 'lc.js', ...args],
      env: { LIGHTCODE_LC_SOCKET: '/tmp/lc.sock', ...o.env },
      exit: (c: number) => {
        throw new Exited(c)
      }
    },
    console: {
      log: (s: unknown) => out.push(String(s)),
      error: (s: unknown) => err.push(String(s))
    }
  })
  const step = (fn: () => void): void => {
    if (code !== null) return
    try {
      fn()
    } catch (e) {
      if (e instanceof Exited) code = e.code
      else throw e
    }
  }
  step(() => new Script(lcClientScript()).runInContext(context))
  if (connected) {
    step(() => handlers['connect']?.())
    if (o.connectError) step(() => handlers['error']?.(new Error('ENOENT')))
    if (o.reply) step(() => handlers['data']?.(JSON.stringify(o.reply)))
    step(() => handlers['close']?.())
  }
  return {
    code: code ?? 0,
    out: out.join('\n'),
    err: err.join('\n'),
    sent: sent === null ? null : (JSON.parse(sent) as Record<string, unknown>)
  }
}

const OK = { ok: true, protocol: LC_PROTOCOL }
const PANE_ENV = { LIGHTCODE_LC_TOKEN: 'secret', LIGHTCODE_PANE: 'p_me' }

describe('the lc client, run', () => {
  // Not only ls and fan, as before: the app cannot judge a send it cannot
  // attribute, and a send is the one that most needs judging.
  it.each([
    ['ls', ['ls']],
    ['read', ['read', 'p_a']],
    ['send', ['send', 'p_a', 'hi']],
    ['close', ['close', 'p_a']],
    ['wait', ['wait', 'p_a']],
    ['fan', ['fan', 'task', '2', 'do it']],
    ['spawn', ['spawn', 'do it']],
    ['ask', ['ask', 'p_a', 'why?']],
    ['result', ['result', 'p_a']],
    ['events', ['events']],
    ['approve', ['approve', 'p_a', 'yes']],
    ['interrupt', ['interrupt', 'p_a']]
  ])('sends the token and the pane with %s', (_label, args) => {
    const run = runClient(args, { env: PANE_ENV, reply: OK })
    expect(run.sent).toMatchObject({ token: 'secret', from: 'p_me' })
  })

  it('reads the text from stdin for send -, without the final newline', () => {
    const run = runClient(['send', 'p_a', '-'], { stdin: 'line one\nline two\n', reply: OK })
    expect(run.sent).toMatchObject({ cmd: 'send', pane: 'p_a', text: 'line one\nline two', enter: true })
  })

  it('passes --force and --no-enter through', () => {
    const run = runClient(['send', 'p_a', 'y', '--force', '--no-enter'], { reply: OK })
    expect(run.sent).toMatchObject({ force: true, enter: false, text: 'y' })
  })

  describe('the orchestra verbs', () => {
    it('spawns with every option it was given, and no prompt when there is none', () => {
      const run = runClient(
        ['spawn', '--agent', 'claude', '--role', 'developer', '--handle', 'dev', '--plan', '--split', 'down', 'fix', 'it'],
        { reply: OK }
      )
      expect(run.sent).toMatchObject({
        cmd: 'spawn',
        agent: 'claude',
        role: 'developer',
        handle: 'dev',
        plan: true,
        split: 'down',
        prompt: 'fix it'
      })
      const bare = runClient(['spawn'], { reply: OK }).sent
      expect(bare).toMatchObject({ cmd: 'spawn', prompt: null, plan: false })
      expect(bare).not.toHaveProperty('worktree')
      expect(bare).not.toHaveProperty('agent')
    })

    it('reads a spawn prompt from stdin', () => {
      const run = runClient(['spawn', '--worktree', '-'], { stdin: 'step one\nstep two\n', reply: OK })
      expect(run.sent).toMatchObject({ worktree: true, prompt: 'step one\nstep two' })
    })

    it('refuses a spawn it cannot make sense of, before connecting', () => {
      expect(runClient(['spawn', '--split', 'sideways']).code).toBe(2)
      expect(runClient(['spawn', '--cwd', '/x', '--worktree']).code).toBe(2)
      expect(runClient(['spawn', '--handle']).code).toBe(2)
    })

    it('asks with the question from stdin, and a timeout', () => {
      const run = runClient(['ask', '@developer', '-', '--timeout-ms', '5000'], {
        stdin: 'what changed?\n',
        reply: OK
      })
      expect(run.sent).toMatchObject({ cmd: 'ask', pane: '@developer', text: 'what changed?', timeoutMs: 5000 })
      expect(runClient(['ask', 'p_a']).code).toBe(2)
    })

    it('prints the answer ask and result bring back, and nothing else', () => {
      const reply = { ...OK, result: { pane: 'p_a', text: 'All 12 tests pass.', source: 'transcript' } }
      expect(runClient(['result', 'p_a'], { reply }).out).toBe('All 12 tests pass.')
      expect(runClient(['ask', 'p_a', 'how?'], { reply }).out).toBe('All 12 tests pass.')
    })

    it('asks for a clean read only when --clean is given', () => {
      expect(runClient(['read', 'p_a'], { reply: OK }).sent).not.toHaveProperty('clean')
      expect(runClient(['read', 'p_a', '--clean'], { reply: OK }).sent).toMatchObject({ clean: true })
    })

    it('takes an event number with or without its #', () => {
      expect(runClient(['events'], { reply: OK }).sent).not.toHaveProperty('since')
      expect(runClient(['events', '--since', '12'], { reply: OK }).sent).toMatchObject({ since: 12 })
      expect(runClient(['events', '--since', '#12'], { reply: OK }).sent).toMatchObject({ since: 12 })
      expect(runClient(['events', '--since', 'soon']).code).toBe(2)
    })

    it('prints each event with its number first, and says when nothing happened', () => {
      const event = { seq: 7, at: 0, crew: 'c_a', pane: 'p_b', handle: 'dev', kind: 'status', state: 'idle' }
      const out = runClient(['events'], { reply: { ...OK, events: [event], seq: 7 } }).out
      expect(out).toMatch(/^#7 {2}.+ {2}@dev \(p_b\) {2}status idle$/)
      expect(runClient(['events'], { reply: { ...OK, events: [], seq: 7 } }).out).toBe(
        '(nothing new; still at #7)'
      )
    })

    it('approves only with a yes or a no', () => {
      expect(runClient(['approve', 'p_a', 'no'], { reply: OK }).sent).toMatchObject({ answer: 'no' })
      expect(runClient(['approve', 'p_a', 'maybe']).code).toBe(2)
    })

    it('prints what spawn opened', () => {
      const spawned = { pane: 'p_n', handle: 'dev', crew: 'c_a', agent: 'claude', cwd: '/repo' }
      expect(runClient(['spawn'], { reply: { ...OK, spawned } }).out).toBe('p_n  @dev  c_a  claude  /repo')
    })

    it('lists the orchestra verbs in its help', () => {
      const out = runClient(['--help']).out
      for (const verb of ['lc spawn', 'lc ask', 'lc result', 'lc events', 'lc approve', 'lc interrupt', '--clean']) {
        expect(out).toContain(verb)
      }
    })
  })

  it.each(['idle', 'exit', 'approval', 'working', 'any'])('accepts wait --for %s', (f) => {
    const run = runClient(['wait', 'p_a', '--for', f], { reply: OK })
    expect(run.sent).toMatchObject({ cmd: 'wait', for: f, panes: ['p_a'] })
  })

  it('lists the new flags and the exit codes in its help', () => {
    const run = runClient(['--help'])
    expect(run.code).toBe(0)
    expect(run.out).toContain('--force')
    expect(run.out).toContain('idle|exit|approval|working|any')
    expect(run.out).toContain('Exit codes')
    expect(run.out).toContain('<text|->')
  })

  describe('exit codes', () => {
    it('is 0 for a reply that went through', () => {
      expect(runClient(['ls'], { reply: { ...OK, panes: [] } }).code).toBe(0)
    })

    it('is 2 for a command it cannot make sense of, before connecting', () => {
      const run = runClient(['wait', 'p_a', '--for', 'lunch'])
      expect(run.code).toBe(2)
      expect(run.sent).toBeNull()
      expect(runClient(['send']).code).toBe(2)
      expect(runClient(['send', 'p_a', '-']).code).toBe(2) // stdin unreadable
    })

    it('is 1 when the app cannot be reached', () => {
      expect(runClient(['ls'], { connectError: true }).code).toBe(1)
      expect(runClient(['ls'], { env: { LIGHTCODE_LC_SOCKET: '' } }).code).toBe(1)
    })

    it('is 1 when the app speaks another protocol', () => {
      expect(runClient(['ls'], { reply: { ok: true, protocol: LC_PROTOCOL - 1 } }).code).toBe(1)
    })

    it.each([
      ['usage', 2],
      ['refused', 3],
      ['timeout', 4],
      ['transport', 1]
    ])('is the code for a %s error', (kind, expected) => {
      const run = runClient(['ls'], { reply: { ok: false, protocol: LC_PROTOCOL, error: 'no', kind } })
      expect(run.code).toBe(expected)
      expect(run.err).toContain('no')
    })

    // An app from before kinds only ever said no about the request itself.
    it('treats a refusal with no kind as refused', () => {
      expect(runClient(['ls'], { reply: { ok: false, protocol: LC_PROTOCOL, error: 'no' } }).code).toBe(3)
    })
  })

  it('asks for the crew only when --crew is given', () => {
    expect(runClient(['ls'], { reply: OK }).sent).not.toHaveProperty('crew')
    expect(runClient(['ls', '--crew'], { reply: OK }).sent).toMatchObject({ cmd: 'ls', crew: true })
  })

  // Resolution is the app's job; the client must not mangle or reject the name.
  it.each([
    ['send', ['send', '@developer', 'hi'], { pane: '@developer' }],
    ['read', ['read', '@lead'], { pane: '@lead' }],
    ['wait', ['wait', '@*', 'p_a'], { panes: ['@*', 'p_a'] }]
  ])('passes an @target through untouched with %s', (_label, args, expected) => {
    expect(runClient(args, { reply: OK }).sent).toMatchObject(expected)
  })

  it('mentions @targets and --crew in its help', () => {
    const out = runClient(['--help']).out
    expect(out).toContain('--crew')
    expect(out).toContain('@lead')
  })

  describe('ls columns', () => {
    const pane = {
      pane: 'p_a',
      tab: 't',
      status: 'idle',
      tool: null,
      contextTokens: 0,
      contextWindow: 200000,
      cwd: '/repo',
      branch: 'main',
      worktree: false,
      role: null,
      self: true
    }

    // The optional-feature rule, at the place a user sees it.
    it('adds no columns to a window without crews or agents', () => {
      const out = runClient(['ls'], { reply: { ...OK, panes: [pane] } }).out
      expect(out).toBe('* p_a  idle      0k/200k      main                      /repo')
    })

    it('shows the handle, the lead and the crew once a pane has them', () => {
      const out = runClient(['ls'], {
        reply: {
          ...OK,
          panes: [
            { ...pane, crew: 'c_x', handle: 'orchestrator', lead: true },
            { ...pane, pane: 'p_b', self: false, crew: 'c_x', handle: 'developer' },
            { ...pane, pane: 'p_c', self: false }
          ]
        }
      }).out
      const [lead, dev, plain] = out.split('\n')
      expect(lead).toContain('@orchestrator (lead)')
      expect(lead).toContain('c_x')
      expect(dev).toContain('@developer')
      expect(dev).not.toContain('(lead)')
      expect(plain).toMatch(/p_c {2}idle {6}- /)
    })

    it('shows the agent column only when some pane names one', () => {
      const without = runClient(['ls'], { reply: { ...OK, panes: [pane] } }).out
      const withAgent = runClient(['ls'], { reply: { ...OK, panes: [{ ...pane, agent: 'codex' }] } }).out
      expect(without).not.toContain('codex')
      expect(withAgent).toContain('codex')
    })

    it('marks an estimated status, and only that one', () => {
      const out = runClient(['ls'], {
        reply: {
          ...OK,
          panes: [
            { ...pane, agent: 'codex', status: 'working', statusSource: 'heuristic' },
            { ...pane, pane: 'p_b', self: false, status: 'working' }
          ]
        }
      }).out
      const [codex, claude] = out.split('\n')
      expect(codex).toContain('~working')
      expect(claude).not.toContain('~')
    })

    it('does not cry wolf about a missing self row in a crew listing', () => {
      const other = { ...pane, self: false, crew: 'c_x', handle: 'dev' }
      expect(runClient(['ls'], { reply: { ...OK, panes: [other] } }).out).toContain('WARNING')
      expect(runClient(['ls', '--crew'], { reply: { ...OK, panes: [other] } }).out).not.toContain('WARNING')
    })
  })

  it('prints a warning to stderr and still succeeds', () => {
    const run = runClient(['send', 'p_a', 'hi'], { reply: { ...OK, warning: 'p_a is mid-turn' } })
    expect(run.code).toBe(0)
    expect(run.err).toBe('warning: p_a is mid-turn')
    expect(run.out).toBe('ok')
  })
})
