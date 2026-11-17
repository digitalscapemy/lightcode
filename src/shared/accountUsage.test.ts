import { describe, expect, it } from 'vitest'
import { DayLedger, billable, dayKey, fmtTokens, lastDays, parseUsageLine } from './accountUsage'

const line = (o: Record<string, unknown>): string => JSON.stringify(o)
const msg = (id: string, ts: string, out: number, extra: Record<string, unknown> = {}): string =>
  line({
    type: 'assistant',
    timestamp: ts,
    requestId: 'req',
    message: { id, model: 'claude-x', usage: { input_tokens: 10, output_tokens: out, cache_read_input_tokens: 100, cache_creation_input_tokens: 5 } },
    ...extra
  })

describe('parseUsageLine', () => {
  it('reads usage, time and identity from an assistant line', () => {
    const u = parseUsageLine(msg('m1', '2026-11-17T03:00:00Z', 7))!
    expect(u.key).toBe('req|m1')
    expect(u.totals).toEqual({ input: 10, output: 7, cacheRead: 100, cacheCreate: 5 })
    expect(u.ts).toBe(Date.parse('2026-11-17T03:00:00Z'))
  })

  it('ignores user lines, synthetic messages, bad JSON and lines without a time', () => {
    expect(parseUsageLine(line({ type: 'user', message: { usage: {} } }))).toBeNull()
    expect(parseUsageLine(msg('m', '2026-11-17T03:00:00Z', 1).replace('claude-x', '<synthetic>'))).toBeNull()
    expect(parseUsageLine('{"usage" "assistant" broken')).toBeNull()
    expect(parseUsageLine(msg('m', 'not a date', 1))).toBeNull()
  })
})

describe('DayLedger', () => {
  it('counts a message streamed over several lines once, the last line winning', () => {
    const l = new DayLedger()
    for (const out of [1, 5, 9]) l.add(parseUsageLine(msg('m1', '2026-11-17T03:00:00Z', out))!)
    const day = dayKey(Date.parse('2026-11-17T03:00:00Z'))
    expect(l.days.get(day)!.output).toBe(9)
    expect(billable(l.days.get(day)!)).toBe(10 + 9 + 5)
  })

  it('keeps separate messages and days apart', () => {
    const l = new DayLedger()
    l.add(parseUsageLine(msg('a', '2026-11-16T10:00:00Z', 3))!)
    l.add(parseUsageLine(msg('b', '2026-11-17T10:00:00Z', 4))!)
    expect(l.days.size).toBe(2)
    expect(l.lastTs).toBe(Date.parse('2026-11-17T10:00:00Z'))
  })
})

describe('helpers', () => {
  it('lists the last 7 local days ending today, oldest first', () => {
    const now = Date.parse('2026-11-17T12:00:00')
    const days = lastDays(now)
    expect(days).toHaveLength(7)
    expect(days[6]).toBe(dayKey(now))
    expect(days[0]! < days[6]!).toBe(true)
  })

  it('formats token counts briefly', () => {
    expect(fmtTokens(950)).toBe('950')
    expect(fmtTokens(1234)).toBe('1.2K')
    expect(fmtTokens(3_400_000)).toBe('3.4M')
  })
})
