import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BUSY_QUIET_MS,
  PROMPT_QUIET_MS,
  QUIET_MS,
  QuietWatcher,
  busyTail,
  noteInput,
  noteOutput,
  notePrompt,
  plainText,
  promptLike,
  quietState,
  settle,
  settleDelay
} from './quietStatus'
import type { PaneStatus } from '../shared/ipc'

describe('the transitions', () => {
  it('ignores output nobody asked for', () => {
    // A redraw on resize, or a clock in a status line, is not a turn.
    const s = quietState()
    expect(noteOutput(s, 'redraw', 0)).toBeNull()
    expect(s.status).toBe('idle')
  })

  it('ignores typing until Enter', () => {
    // The echo of each key is output after input too.
    const s = quietState()
    noteInput(s, 'h')
    expect(noteOutput(s, 'h', 0)).toBeNull()
    noteInput(s, '\r')
    expect(noteOutput(s, 'thinking…', 10)).toBe('working')
  })

  it('reports working once, however much it prints', () => {
    const s = quietState()
    noteInput(s, 'go\r')
    expect(noteOutput(s, 'a', 0)).toBe('working')
    noteInput(s, '\r')
    expect(noteOutput(s, 'b', 5)).toBeNull()
  })

  it('calls the turn over after quiet under a prompt', () => {
    const s = quietState()
    noteInput(s, '\r')
    noteOutput(s, 'Done.\n› ', 1000)
    expect(settle(s, 1000 + PROMPT_QUIET_MS - 1)).toBeNull()
    expect(settle(s, 1000 + PROMPT_QUIET_MS)).toBe('waiting-input')
    expect(settle(s, 1000 + PROMPT_QUIET_MS + 50)).toBeNull()
  })

  it('waits longer on quiet alone', () => {
    const s = quietState()
    noteInput(s, '\r')
    noteOutput(s, 'compiling module 3 of 9', 0)
    expect(settle(s, PROMPT_QUIET_MS)).toBeNull()
    expect(settle(s, QUIET_MS)).toBe('waiting-input')
  })

  it('waits longest while the screen says it is busy', () => {
    const s = quietState()
    noteInput(s, '\r')
    noteOutput(s, 'Working (4s • esc to interrupt)', 0)
    expect(settle(s, QUIET_MS)).toBeNull()
    expect(settle(s, BUSY_QUIET_MS)).toBe('waiting-input')
  })

  it('starts the next turn on the next Enter', () => {
    const s = quietState()
    noteInput(s, '\r')
    noteOutput(s, '> ', 0)
    settle(s, PROMPT_QUIET_MS)
    expect(noteOutput(s, 'cursor blink redraw', PROMPT_QUIET_MS + 10)).toBeNull()
    noteInput(s, 'next\r')
    expect(noteOutput(s, 'ok', PROMPT_QUIET_MS + 20)).toBe('working')
  })

  it('goes idle when the shell prompt comes back, and only once', () => {
    const s = quietState()
    noteInput(s, '\r')
    noteOutput(s, 'x', 0)
    expect(notePrompt(s)).toBe('idle')
    expect(notePrompt(s)).toBeNull()
    expect(s.armed).toBe(false)
  })

  it('never says waiting-approval', () => {
    const s = quietState()
    noteInput(s, '\r')
    noteOutput(s, 'Allow command? (y/n) ', 0)
    expect(settle(s, BUSY_QUIET_MS)).toBe('waiting-input')
  })
})

describe('the tail', () => {
  it('strips escapes and turns carriage returns into line breaks', () => {
    expect(plainText('\x1b[1;32mok\x1b[0m\r\n\x1b]0;title\x07> ')).toBe('ok\n\n> ')
  })

  it.each(['› ', '> ', '❯', 'user@host:~$ ', 'PS C:\\repo> ', '⏎ send   ⌃J newline', '? for shortcuts', 'Type your message or @path/to/file'])(
    'reads %j as a prompt',
    (tail) => {
      expect(promptLike(`some answer\n${tail}`)).toBe(true)
    }
  )

  it.each(['compiling module 3 of 9', 'Running tests', ''])('does not read %j as a prompt', (tail) => {
    expect(promptLike(`header\n${tail}`)).toBe(false)
  })

  it('looks at the last line with something on it', () => {
    expect(promptLike('> \n\n   \n')).toBe(true)
  })

  it('knows a busy footer', () => {
    expect(busyTail('Working (12s • esc to interrupt)')).toBe(true)
    expect(busyTail('⠋ Thinking (esc to cancel, 3s)')).toBe(true)
    expect(busyTail('all done')).toBe(false)
    expect(settleDelay('esc to interrupt')).toBe(BUSY_QUIET_MS)
  })
})

describe('QuietWatcher', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  const setup = (): { w: QuietWatcher; seen: [string, PaneStatus][] } => {
    vi.useFakeTimers()
    const seen: [string, PaneStatus][] = []
    const w = new QuietWatcher(
      (pane, status) => seen.push([pane, status]),
      () => Date.now()
    )
    return { w, seen }
  }

  it('reports a turn start and its end on the clock', () => {
    const { w, seen } = setup()
    w.watch('p1')
    w.input('p1', 'go\r')
    w.output('p1', 'answer\n> ')
    expect(seen).toEqual([['p1', 'working']])
    vi.advanceTimersByTime(PROMPT_QUIET_MS)
    expect(seen).toEqual([
      ['p1', 'working'],
      ['p1', 'waiting-input']
    ])
  })

  it('restarts the clock on every bit of output', () => {
    const { w, seen } = setup()
    w.watch('p1')
    w.input('p1', '\r')
    w.output('p1', 'tick')
    vi.advanceTimersByTime(QUIET_MS - 100)
    w.output('p1', 'tock')
    vi.advanceTimersByTime(QUIET_MS - 100)
    expect(seen).toEqual([['p1', 'working']])
    vi.advanceTimersByTime(100)
    expect(seen.at(-1)).toEqual(['p1', 'waiting-input'])
  })

  it('ignores panes it is not watching, and forgets ones it was', () => {
    const { w, seen } = setup()
    w.input('p2', '\r')
    w.output('p2', 'x')
    w.watch('p1')
    w.input('p1', '\r')
    w.output('p1', 'x')
    w.forget('p1')
    vi.advanceTimersByTime(BUSY_QUIET_MS)
    expect(seen).toEqual([['p1', 'working']])
    expect(w.watching('p1')).toBe(false)
  })

  it('goes idle at the shell prompt and cancels the clock', () => {
    const { w, seen } = setup()
    w.watch('p1')
    w.input('p1', '\r')
    w.output('p1', 'x')
    w.prompt('p1')
    vi.advanceTimersByTime(BUSY_QUIET_MS)
    expect(seen).toEqual([
      ['p1', 'working'],
      ['p1', 'idle']
    ])
  })
})
