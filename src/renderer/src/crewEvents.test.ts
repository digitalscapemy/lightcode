import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CrewEventLog, eventText, firstWords } from './crewEvents'
import type { CrewEventInput } from './crewEvents'

const ev = (pane: string, crew = 'c_a'): CrewEventInput => ({
  crew,
  pane,
  handle: pane.replace(/^p_/, ''),
  kind: 'status',
  state: 'idle'
})

describe('CrewEventLog', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('numbers events from 1, in order', () => {
    const log = new CrewEventLog()
    expect(log.latest()).toBe(0)
    expect(log.push(ev('p_a')).seq).toBe(1)
    expect(log.push(ev('p_b')).seq).toBe(2)
    expect(log.latest()).toBe(2)
  })

  it('hands back only what came after since', () => {
    const log = new CrewEventLog()
    log.push(ev('p_a'))
    log.push(ev('p_b'))
    log.push(ev('p_c'))
    const page = log.since(1)
    expect(page.events.map((e) => e.pane)).toEqual(['p_b', 'p_c'])
    expect(page.seq).toBe(3)
    expect(page.dropped).toBe(0)
  })

  it('filters to what the caller may see', () => {
    const log = new CrewEventLog()
    log.push(ev('p_a', 'c_a'))
    log.push(ev('p_b', 'c_b'))
    expect(log.since(0, (e) => e.crew === 'c_b').events.map((e) => e.pane)).toEqual(['p_b'])
  })

  it('keeps only the newest events, and says how many a late reader missed', () => {
    const log = new CrewEventLog(3)
    for (let i = 1; i <= 5; i++) log.push(ev(`p_${i}`))
    const page = log.since(0)
    expect(page.events.map((e) => e.seq)).toEqual([3, 4, 5])
    expect(page.dropped).toBe(2)
    expect(log.since(2).dropped).toBe(0)
    expect(log.since(1).dropped).toBe(1)
  })

  it('answers a wait at once when something is already there', async () => {
    const log = new CrewEventLog()
    log.push(ev('p_a'))
    const page = await log.wait(0, 10_000)
    expect(page.events).toHaveLength(1)
    expect(log.waiting()).toBe(0)
  })

  it('holds a wait until the next event, then wakes it', async () => {
    const log = new CrewEventLog()
    log.push(ev('p_a'))
    const pending = log.wait(1, 10_000)
    expect(log.waiting()).toBe(1)
    log.push(ev('p_b'))
    const page = await pending
    expect(page.events.map((e) => e.pane)).toEqual(['p_b'])
    expect(log.waiting()).toBe(0)
  })

  it('is not woken by an event it may not see', async () => {
    const log = new CrewEventLog()
    let settled = false
    const pending = log.wait(0, 10_000, (e) => e.crew === 'c_mine').then((p) => {
      settled = true
      return p
    })
    log.push(ev('p_other', 'c_other'))
    await Promise.resolve()
    expect(settled).toBe(false)
    log.push(ev('p_mine', 'c_mine'))
    expect((await pending).events.map((e) => e.pane)).toEqual(['p_mine'])
  })

  // Nothing happening is an answer, not an error.
  it('comes back empty when the time runs out', async () => {
    const log = new CrewEventLog()
    const pending = log.wait(0, 5_000)
    vi.advanceTimersByTime(5_000)
    const page = await pending
    expect(page.events).toEqual([])
    expect(page.seq).toBe(0)
    expect(log.waiting()).toBe(0)
  })
})

describe('CrewEventLog listeners and recent', () => {
  it('tells a listener about every push until it unsubscribes', () => {
    const log = new CrewEventLog()
    const heard: number[] = []
    const stop = log.listen((e) => heard.push(e.seq))
    log.push(ev('p_a'))
    log.push(ev('p_b'))
    stop()
    log.push(ev('p_c'))
    expect(heard).toEqual([1, 2])
  })

  // The panel's timeline: the last few, oldest first, never more than kept.
  it('recent gives the newest n, oldest first', () => {
    const log = new CrewEventLog(3)
    for (const p of ['p_a', 'p_b', 'p_c', 'p_d']) log.push(ev(p))
    expect(log.recent(2).map((e) => e.pane)).toEqual(['p_c', 'p_d'])
    expect(log.recent(20).map((e) => e.pane)).toEqual(['p_b', 'p_c', 'p_d'])
    expect(log.recent(0)).toEqual([])
  })
})

describe('firstWords', () => {
  it('flattens whitespace and shortens long text', () => {
    expect(firstWords('one\n  two\tthree')).toBe('one two three')
    const long = firstWords('x'.repeat(200))
    expect(long).toHaveLength(80)
    expect(long.endsWith('…')).toBe(true)
  })
})

describe('eventText', () => {
  it('says a status as its word, with the tool asked about', () => {
    expect(eventText({ kind: 'status', state: 'approval', detail: 'Bash' })).toBe('approval: Bash')
    expect(eventText({ kind: 'status', state: 'idle' })).toBe('idle')
  })

  it('says who did it and what', () => {
    expect(eventText({ kind: 'sent', by: '@lead', detail: 'run the tests' })).toBe('sent by @lead: run the tests')
    expect(eventText({ kind: 'paused', by: 'you' })).toBe('paused by you')
    expect(eventText({ kind: 'reported', detail: 'developer.md' })).toBe('filed developer.md')
  })
})
