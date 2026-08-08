import { execFileSync } from 'child_process'
import { mkdtempSync, readdirSync, readFileSync, renameSync, utimesSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import {
  HOOK_EVENTS,
  HookWatcher,
  isPermissionNotification,
  parseEnvelope,
  posixScript,
  renderHookSettings,
  reporterCommand,
  statusForEvent
} from './agentHooks'
import type { HookEvent } from './agentHooks'

const envelope = (pane: string, hook: Record<string, unknown>): string =>
  JSON.stringify({ pane, hook })

const event = (over: Partial<HookEvent> = {}): HookEvent => ({
  paneId: 'p_abc123',
  event: 'Stop',
  sessionId: 's1',
  cwd: '/work',
  transcriptPath: '/root/projects/-work/s1.jsonl',
  toolName: null,
  toolUseId: null,
  message: null,
  agentId: null,
  ...over
})

describe('parseEnvelope', () => {
  it('reads the pane, the event and the fields we act on', () => {
    const ev = parseEnvelope(
      envelope('p_abc123', {
        hook_event_name: 'PermissionRequest',
        session_id: 's1',
        cwd: '/work',
        transcript_path: '/root/projects/-work/s1.jsonl',
        tool_name: 'Bash',
        tool_use_id: 'toolu_9'
      })
    )
    expect(ev).toEqual(
      event({ event: 'PermissionRequest', toolName: 'Bash', toolUseId: 'toolu_9' })
    )
  })

  it('leaves absent fields null rather than undefined', () => {
    const ev = parseEnvelope(envelope('p_a', { hook_event_name: 'Stop' }))
    expect(ev).toMatchObject({ paneId: 'p_a', event: 'Stop', toolName: null, agentId: null })
  })

  // The envelope is assembled by a shell script around a payload we do not
  // control, so every one of these has to be survivable rather than thrown.
  it.each([
    ['not json at all', '{"pane":"p_a","hook":'],
    ['an empty file', ''],
    ['no pane', JSON.stringify({ hook: { hook_event_name: 'Stop' } })],
    ['no event', envelope('p_a', {})],
    ['an event we did not ask for', envelope('p_a', { hook_event_name: 'PreToolUse' })],
    ['a non-string event', envelope('p_a', { hook_event_name: 7 })],
    ['a pane id that is not ours', envelope('p a"; rm -rf /', { hook_event_name: 'Stop' })]
  ])('returns null for %s', (_label, text) => {
    expect(parseEnvelope(text)).toBeNull()
  })
})

describe('isPermissionNotification', () => {
  // Claude Code notifies for two different reasons, and only one of them means
  // somebody is blocked. Mapping the idle one to "needs approval" would light
  // the red dot on a session nothing is waiting for.
  it.each([
    'Claude needs your permission to use Bash',
    'Claude wants to run a command',
    'Allow Edit to modify src/index.ts?'
  ])('treats %s as a permission prompt', (msg) => {
    expect(isPermissionNotification(msg)).toBe(true)
  })

  it.each(['Claude is waiting for your input', 'Session idle for 60 seconds', ''])(
    'does not treat %s as one',
    (msg) => {
      expect(isPermissionNotification(msg)).toBe(false)
    }
  )

  it('handles a missing message', () => {
    expect(isPermissionNotification(null)).toBe(false)
  })
})

describe('statusForEvent', () => {
  it('maps a submitted prompt to working', () => {
    expect(statusForEvent(event({ event: 'UserPromptSubmit' }))).toBe('working')
  })

  it('maps a turn end to waiting-input', () => {
    expect(statusForEvent(event({ event: 'Stop' }))).toBe('waiting-input')
  })

  it('maps a permission request to waiting-approval', () => {
    expect(statusForEvent(event({ event: 'PermissionRequest' }))).toBe('waiting-approval')
  })

  it('maps a permission-shaped notification to waiting-approval', () => {
    const ev = event({ event: 'Notification', message: 'Claude needs your permission' })
    expect(statusForEvent(ev)).toBe('waiting-approval')
  })

  it('ignores an idle notification', () => {
    const ev = event({ event: 'Notification', message: 'still here' })
    expect(statusForEvent(ev)).toBeNull()
  })

  // A fresh session sits at its prompt with nothing asked of it yet. Reporting
  // waiting-input would arm the babysitter on a pane nobody has typed into.
  it('carries no status for SessionStart', () => {
    expect(statusForEvent(event({ event: 'SessionStart' }))).toBeNull()
  })

  it('ignores subagent traffic, which is not the main thread', () => {
    expect(statusForEvent(event({ event: 'Stop', agentId: 'agent-1' }))).toBeNull()
  })
})

describe('renderHookSettings', () => {
  const settings = renderHookSettings('/bin/sh', ['/tmp/report.sh']) as {
    hooks: Record<string, { hooks: Record<string, unknown>[] }[]>
  }

  it('subscribes to every event we handle, and nothing else', () => {
    expect(Object.keys(settings.hooks).sort()).toEqual([...HOOK_EVENTS].sort())
  })

  it('uses exec form so no shell can re-tokenise a path with spaces', () => {
    const handler = settings.hooks['Stop']?.[0]?.hooks[0]
    expect(handler).toMatchObject({ type: 'command', command: '/bin/sh', args: ['/tmp/report.sh'] })
  })

  // A hook that blocked would be felt at every turn boundary, and on Windows
  // each run is a PowerShell start-up.
  it('never makes Claude wait for us', () => {
    for (const entries of Object.values(settings.hooks)) {
      expect(entries[0]?.hooks[0]).toMatchObject({ async: true })
    }
  })

  it('survives a JSON round trip, since that is how it is delivered', () => {
    expect(JSON.parse(JSON.stringify(settings))).toEqual(settings)
  })
})

// The reporter is a shell script, so the only test worth having runs it.
describe.skipIf(process.platform === 'win32')('the POSIX reporter', () => {
  function runScript(env: Record<string, string>, stdin: string): number {
    const script = writeScript()
    const spool = mkdtempSync(join(tmpdir(), 'lc-spool-'))
    execFileSync('/bin/sh', [script], {
      input: stdin,
      env: { ...hermeticEnv(), LIGHTCODE_HOOK_DIR: spool, ...env }
    })
    const files = readdirSync(spool).filter((f) => f.endsWith('.json'))
    if (files.length === 1) lastEnvelope = readFileSync(join(spool, files[0]), 'utf8')
    return files.length
  }
  let lastEnvelope = ''

  function writeScript(): string {
    const dir = mkdtempSync(join(tmpdir(), 'lc-hook-'))
    const script = join(dir, 'report.sh')
    writeFileSync(script, posixScript())
    return script
  }

  /**
   * The suite's own environment, minus anything the app injects into a pane.
   *
   * Light Code is a terminal, so `npm test` is very often run inside one of its
   * panes — where LIGHTCODE_PANE and LIGHTCODE_HOOK_DIR are both set. Inheriting
   * those made "writes nothing without a pane id" fail there, and pointed the
   * reporter at the running app's real spool, posting test envelopes into it.
   */
  function hermeticEnv(): NodeJS.ProcessEnv {
    return Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith('LIGHTCODE_'))
    )
  }

  const payload = JSON.stringify({ hook_event_name: 'Stop', session_id: 's1' })

  it('writes one envelope the app can parse', () => {
    expect(runScript({ LIGHTCODE_PANE: 'p_xy' }, payload)).toBe(1)
    expect(parseEnvelope(lastEnvelope)).toMatchObject({ paneId: 'p_xy', event: 'Stop' })
  })

  // The same file is on disk for every Claude Code session on the machine, not
  // just ours. Outside a Light Code pane it has to do nothing at all.
  it('writes nothing without a pane id', () => {
    expect(runScript({}, payload)).toBe(0)
  })

  it('writes nothing when the spool is gone', () => {
    expect(
      runScript({ LIGHTCODE_PANE: 'p_xy', LIGHTCODE_HOOK_DIR: '/nonexistent-lc' }, payload)
    ).toBe(0)
  })

  // A non-zero exit prints "<hook> hook error" into the user's transcript.
  it('exits 0 even with nothing to do', () => {
    expect(() =>
      execFileSync('/bin/sh', [writeScript()], { input: '', env: hermeticEnv() })
    ).not.toThrow()
  })
})

/**
 * The spool reader. Ordering is the part that matters: applying `Stop` before
 * the `PermissionRequest` that preceded it would clear the prompt flag first and
 * leave the red dot lit after the question had been answered.
 */
describe('HookWatcher', () => {
  const envelopeFor = (event: string, extra: Record<string, unknown> = {}): string =>
    JSON.stringify({ pane: 'p_a', hook: { hook_event_name: event, ...extra } })

  /** Drop a finished envelope with an explicit mtime, atomically. */
  function drop(spool: string, name: string, body: string, mtimeSec: number): void {
    const tmp = join(spool, name)
    writeFileSync(tmp, body)
    renameSync(tmp, `${tmp}.json`)
    utimesSync(`${tmp}.json`, mtimeSec, mtimeSec)
  }

  /** Long enough for the fire-and-forget start-up purge to have run. */
  const settle = (): Promise<void> => new Promise((done) => setTimeout(done, 50))

  /**
   * Seeding happens AFTER start, deliberately: start() purges the spool, so
   * envelopes written before it are meant to disappear (the last test pins that).
   */
  async function collect(seed: (spool: string) => void): Promise<{
    events: HookEvent[]
    left: string[]
  }> {
    const spool = mkdtempSync(join(tmpdir(), 'lc-watch-'))
    const events: HookEvent[] = []
    const watcher = new HookWatcher()
    watcher.start(spool, (ev) => events.push(ev))
    await settle()
    seed(spool)
    await watcher.drainNow()
    watcher.stop()
    return { events, left: readdirSync(spool) }
  }

  it('reports events oldest first, whatever the filenames sort like', async () => {
    // Names deliberately sort the wrong way round: the reporter stamps seconds,
    // which cannot separate two events inside the same second.
    const { events } = await collect((spool) => {
      drop(spool, 'zzz-1', envelopeFor('PermissionRequest', { tool_name: 'Write' }), 1_700_000_000)
      drop(spool, 'aaa-2', envelopeFor('Stop'), 1_700_000_005)
    })
    expect(events.map((e) => e.event)).toEqual(['PermissionRequest', 'Stop'])
  })

  it('consumes what it reports, so nothing is replayed', async () => {
    const { events, left } = await collect((spool) => {
      drop(spool, 'a-1', envelopeFor('Stop'), 1_700_000_000)
    })
    expect(events).toHaveLength(1)
    expect(left).toEqual([])
  })

  // A half-written envelope has no .json yet — the reporter renames it into
  // place only once complete.
  it('ignores a file still being written', async () => {
    const { events, left } = await collect((spool) => {
      writeFileSync(join(spool, 'partial-1'), '{"pane":"p_a","hook":')
    })
    expect(events).toEqual([])
    expect(left).toEqual(['partial-1'])
  })

  it('drops an unparseable envelope without losing the ones around it', async () => {
    const { events, left } = await collect((spool) => {
      drop(spool, 'a-1', envelopeFor('UserPromptSubmit'), 1_700_000_000)
      drop(spool, 'b-2', 'not json at all', 1_700_000_001)
      drop(spool, 'c-3', envelopeFor('Stop'), 1_700_000_002)
    })
    expect(events.map((e) => e.event)).toEqual(['UserPromptSubmit', 'Stop'])
    expect(left).toEqual([]) // the bad one is deleted too, never retried for ever
  })

  // Envelopes outliving a launch belong to panes that no longer exist.
  it('throws away whatever the last run left behind', async () => {
    const spool = mkdtempSync(join(tmpdir(), 'lc-watch-'))
    drop(spool, 'stale-1', envelopeFor('Stop'), 1_700_000_000)
    const events: HookEvent[] = []
    const watcher = new HookWatcher()
    watcher.start(spool, (ev) => events.push(ev))
    await settle() // let the purge land
    await watcher.drainNow()
    watcher.stop()
    expect(events).toEqual([])
    expect(readdirSync(spool)).toEqual([])
  })
})

describe('reporterCommand', () => {
  it('passes the script as an argument rather than relying on the execute bit', () => {
    const { command, args } = reporterCommand('/tmp/r.sh')
    if (process.platform === 'win32') {
      expect(command).toBe('powershell.exe')
      expect(args).toContain('-NoProfile')
      expect(args[args.length - 1]).toBe('/tmp/r.sh')
    } else {
      expect(command).toBe('/bin/sh')
      expect(args).toEqual(['/tmp/r.sh'])
    }
  })
})
