import { describe, expect, it } from 'vitest'
import { LcServer, parseRequest, resolveCaller, socketOwnerPid, timeoutFor } from './lcServer'
import { LC_COMMANDS, LC_SOCKET_PREFIX, LC_SOCKET_SUFFIX } from '../shared/lc'
import type { LcRequest } from '../shared/lc'

/**
 * Anything at all can be written to this socket, so every one of these has to be
 * answerable rather than throwable — a malformed line must come back as a
 * sentence, not take the app down.
 */
describe('parseRequest', () => {
  it('accepts a command it knows', () => {
    const out = parseRequest('{"cmd":"ls"}')
    expect(out).toEqual({ req: { cmd: 'ls' } })
  })

  it('keeps the arguments alongside the command', () => {
    const out = parseRequest('{"cmd":"send","pane":"p_a","text":"hi","enter":true}')
    expect(out).toMatchObject({ req: { cmd: 'send', pane: 'p_a', text: 'hi' } })
  })

  it.each([
    ['not json at all', 'hello'],
    ['an empty line', ''],
    ['a bare number', '42'],
    ['null', 'null'],
    ['an array', '[1,2,3]'],
    ['an object with no cmd', '{"pane":"p_a"}'],
    ['a cmd that is not a string', '{"cmd":7}']
  ])('refuses %s without throwing', (_label, line) => {
    const out = parseRequest(line)
    expect(out).toHaveProperty('error')
  })

  // The list the server checks and the list the protocol publishes are one.
  it.each(LC_COMMANDS)('accepts every published command: %s', (cmd) => {
    expect(parseRequest(JSON.stringify({ cmd }))).toEqual({ req: { cmd } })
  })

  // Naming the command back is what makes a typo fixable from the message alone.
  it('names an unknown command and lists the real ones', () => {
    const out = parseRequest('{"cmd":"destroy"}')
    expect(out).toHaveProperty('error')
    if ('error' in out) {
      expect(out.error).toContain('destroy')
      expect(out.error).toContain('ls')
    }
  })
})

/**
 * What this decides is which files get deleted out of userData while other
 * copies of the app are running. A name read as a pid that is not one costs
 * somebody their live socket and sends their agents into the wrong window,
 * which is the whole reason the pid is in the name.
 */
describe('socketOwnerPid', () => {
  // The one case that must never drift: the reader has to agree with the writer
  // in socketPath, or the sweep stops recognising this app's own sockets.
  it('reads back the name this process would bind', () => {
    const mine = `${LC_SOCKET_PREFIX}${process.pid}${LC_SOCKET_SUFFIX}`
    expect(socketOwnerPid(mine)).toBe(process.pid)
  })

  it.each([
    ['the fixed name older versions used', 'lc.sock'],
    ['no pid at all', 'lc-.sock'],
    ['a pid that is not a number', 'lc-abc.sock'],
    ['digits with something after them', 'lc-12ab.sock'],
    ['a leading zero we would never write', 'lc-0012.sock'],
    ['a suffix of our own with more behind it', 'lc-12.sock.bak'],
    ['somebody else\'s socket entirely', 'agent.sock'],
    ['the switch file that lives in the same folder', 'enabled.json']
  ])('refuses to claim %s', (_label, name) => {
    expect(socketOwnerPid(name)).toBeNull()
  })
})

describe('timeoutFor', () => {
  const req = (r: LcRequest): LcRequest => r

  it('gives a plain question a short deadline', () => {
    expect(timeoutFor(req({ cmd: 'ls' }))).toBe(15_000)
  })

  // wait is allowed to sit there — that is its job — but the socket has to give
  // up slightly later than the wait itself, or the caller gets a timeout from
  // the wrong layer and a worse message.
  it('outlives the wait it is carrying', () => {
    expect(timeoutFor(req({ cmd: 'wait', panes: ['p'], for: 'idle', timeoutMs: 60_000 }))).toBe(
      65_000
    )
  })

  it('caps a wait that asks for longer than anyone should hold a socket', () => {
    const forever = req({ cmd: 'wait', panes: ['p'], for: 'idle', timeoutMs: 999 * 60_000 })
    expect(timeoutFor(forever)).toBe(15 * 60_000)
  })

  it.each(['idle', 'exit', 'approval', 'working', 'any'] as const)(
    'outlives a wait for %s the same way',
    (f) => {
      expect(timeoutFor(req({ cmd: 'wait', panes: ['p'], for: f, timeoutMs: 1_000 }))).toBe(6_000)
    }
  )

  it('gives a fan-out room to create worktrees and start agents', () => {
    expect(timeoutFor(req({ cmd: 'fan', task: 't', count: 2, prompt: 'p', plan: false }))).toBe(
      15 * 60_000
    )
  })

  it('gives spawn and ask the long deadline', () => {
    expect(timeoutFor(req({ cmd: 'spawn', plan: false, prompt: null }))).toBe(15 * 60_000)
    expect(timeoutFor(req({ cmd: 'ask', pane: 'p', text: 'q', timeoutMs: 1_000 }))).toBe(15 * 60_000)
  })

  // A long-poll is a wait by another name.
  it('outlives an events long-poll the way it outlives a wait', () => {
    expect(timeoutFor(req({ cmd: 'events', since: 3, timeoutMs: 30_000 }))).toBe(35_000)
    expect(timeoutFor(req({ cmd: 'events', since: 3, timeoutMs: 999 * 60_000 }))).toBe(15 * 60_000)
  })

  it.each(['result', 'approve', 'interrupt'] as const)('gives %s the short deadline', (cmd) => {
    const r =
      cmd === 'approve'
        ? req({ cmd, pane: 'p', answer: 'yes' })
        : req({ cmd, pane: 'p' })
    expect(timeoutFor(r)).toBe(15_000)
  })
})

/**
 * Who a request is from decides what it may do — not least whether it is
 * typing into its own pane. The pane id is printed by `lc ls` for anyone to
 * copy; only the token was put in one pane's environment and nowhere else.
 */
describe('resolveCaller', () => {
  const tokens = new Map([['t_good', 'p_real']])
  const lookup = (t: string): string | null => tokens.get(t) ?? null

  it('names the caller from its token', () => {
    const out = resolveCaller({ cmd: 'ls', token: 't_good' }, lookup)
    expect(out).toEqual({ cmd: 'ls', from: 'p_real' })
  })

  it('ignores a forged from when the token says otherwise', () => {
    const out = resolveCaller({ cmd: 'send', pane: 'p_x', text: 'hi', enter: true, token: 't_good', from: 'p_x' }, lookup)
    expect(out.from).toBe('p_real')
    expect(out.unverified).toBeUndefined()
  })

  it('keeps the claimed from without a token, and flags it', () => {
    expect(resolveCaller({ cmd: 'ls', from: 'p_a' }, lookup)).toEqual({
      cmd: 'ls',
      from: 'p_a',
      unverified: true
    })
  })

  it('treats a token it never issued as no token at all', () => {
    expect(resolveCaller({ cmd: 'ls', token: 't_forged', from: 'p_a' }, lookup)).toEqual({
      cmd: 'ls',
      from: 'p_a',
      unverified: true
    })
  })

  // The flag is the server's to set; whatever the client sent is recomputed.
  it("decides unverified itself rather than taking the client's word", () => {
    expect(resolveCaller({ cmd: 'ls', token: 't_good', unverified: true }, lookup)).toEqual({
      cmd: 'ls',
      from: 'p_real'
    })
    expect(resolveCaller({ cmd: 'ls', unverified: true }, lookup)).toEqual({ cmd: 'ls' })
  })

  // The renderer never needs the secret, so it never gets it.
  it('drops the token before the request goes any further', () => {
    expect(resolveCaller({ cmd: 'ls', token: 't_good' }, lookup)).not.toHaveProperty('token')
    expect(resolveCaller({ cmd: 'ls', token: 't_forged' }, lookup)).not.toHaveProperty('token')
  })
})

describe('LcServer tokens', () => {
  it('issues a token that names its pane, until it is revoked', () => {
    const server = new LcServer()
    const token = server.issueToken('p_a')
    expect(token).toMatch(/^[0-9a-f]{32}$/)
    expect(server.paneOfToken(token)).toBe('p_a')
    server.revokeToken('p_a')
    expect(server.paneOfToken(token)).toBeNull()
  })

  // A respawned shell is a new caller; the old shell's token dies with it.
  it("replaces a pane's token when it is issued another", () => {
    const server = new LcServer()
    const first = server.issueToken('p_a')
    const second = server.issueToken('p_a')
    expect(second).not.toBe(first)
    expect(server.paneOfToken(first)).toBeNull()
    expect(server.paneOfToken(second)).toBe('p_a')
  })

  it("keeps every pane's token apart", () => {
    const server = new LcServer()
    const a = server.issueToken('p_a')
    const b = server.issueToken('p_b')
    server.revokeToken('p_a')
    expect(server.paneOfToken(a)).toBeNull()
    expect(server.paneOfToken(b)).toBe('p_b')
    server.revokeToken('p_nobody') // nothing to revoke is not an error
  })
})
