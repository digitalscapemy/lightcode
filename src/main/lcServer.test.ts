import { describe, expect, it } from 'vitest'
import { parseRequest, socketOwnerPid, timeoutFor } from './lcServer'
import { LC_SOCKET_PREFIX, LC_SOCKET_SUFFIX } from '../shared/lc'
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

  it('gives a fan-out room to create worktrees and start agents', () => {
    expect(timeoutFor(req({ cmd: 'fan', task: 't', count: 2, prompt: 'p', plan: false }))).toBe(
      15 * 60_000
    )
  })
})
