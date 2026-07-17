import { describe, expect, it } from 'vitest'
import { deriveStatus, emptyFileState, ingest } from './usageWatcher'
import type { FileState } from './usageWatcher'

/**
 * The dot is exactly `deriveStatus(fold(ingest, lines))` — no timers, no
 * clock. These tests pin the turn-state machine that replaced the old
 * "silent for 4s ⇒ not working" heuristic, which was wrong ~30% of the time
 * because the transcript is silent *precisely while* work happens.
 */

const prompt = (text = 'hi'): string =>
  JSON.stringify({ type: 'user', message: { role: 'user', content: text } })

const toolResult = (): string =>
  JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] }
  })

interface AssistantOpts {
  stop?: string
  tool?: string
  usage?: Record<string, number>
  id?: string
  requestId?: string
  model?: string
  sidechain?: boolean
}

const assistant = (o: AssistantOpts = {}): string =>
  JSON.stringify({
    type: 'assistant',
    uuid: `u-${Math.random()}`,
    requestId: o.requestId ?? 'req-1',
    ...(o.sidechain ? { isSidechain: true } : {}),
    message: {
      id: o.id ?? 'msg-1',
      model: o.model ?? 'claude-opus-4-8',
      stop_reason: o.stop ?? 'end_turn',
      content: o.tool ? [{ type: 'tool_use', name: o.tool }] : [{ type: 'text', text: 'hi' }],
      ...(o.usage ? { usage: o.usage } : {})
    }
  })

/** Feed lines in order and report the status the dot would show. */
function play(...lines: string[]): { state: FileState; status: string } {
  const state = emptyFileState()
  for (const l of lines) ingest(state, l)
  return { state, status: deriveStatus(state) }
}

describe('deriveStatus — turn state', () => {
  it('is idle before anything happens', () => {
    expect(play().status).toBe('idle')
  })

  it('is working the moment a prompt lands', () => {
    expect(play(prompt()).status).toBe('working')
  })

  it('is waiting-input once the turn ends', () => {
    expect(play(prompt(), assistant({ stop: 'end_turn' })).status).toBe('waiting-input')
  })

  it.each(['end_turn', 'stop_sequence', 'max_tokens'])('treats %s as turn end', (stop) => {
    expect(play(prompt(), assistant({ stop })).status).toBe('waiting-input')
  })

  // The regression that made the dot flash red on every slow build: a tool
  // that takes longer than the old 4s window is still just... working.
  it('stays working across a long tool call, however slow', () => {
    expect(play(prompt(), assistant({ stop: 'tool_use', tool: 'PowerShell' })).status).toBe(
      'working'
    )
  })

  it('stays working after the tool result returns', () => {
    const { status } = play(
      prompt(),
      assistant({ stop: 'tool_use', tool: 'Bash' }),
      toolResult()
    )
    expect(status).toBe('working')
  })

  it('never reports waiting-approval — the transcript cannot know', () => {
    const seen = [
      play(prompt()),
      play(prompt(), assistant({ stop: 'tool_use', tool: 'Bash' })),
      play(prompt(), assistant({ stop: 'tool_use', tool: 'Bash' }), toolResult()),
      play(prompt(), assistant({ stop: 'end_turn' }))
    ].map((r) => r.status)
    expect(seen).not.toContain('waiting-approval')
  })

  it('reopens a turn when the user replies after one ended', () => {
    expect(play(prompt(), assistant({ stop: 'end_turn' }), prompt('again')).status).toBe(
      'working'
    )
  })

  // isMeta lines land *after* a completed turn; counting them as a prompt
  // would pin the dot to working forever.
  it('ignores isMeta user lines', () => {
    const meta = JSON.stringify({ type: 'user', isMeta: true, message: { content: 'x' } })
    expect(play(prompt(), assistant({ stop: 'end_turn' }), meta).status).toBe('waiting-input')
  })

  it('ignores sidechain traffic on both sides', () => {
    const sideUser = JSON.stringify({ type: 'user', isSidechain: true, message: { content: 'x' } })
    const { status } = play(
      prompt(),
      assistant({ stop: 'end_turn' }),
      sideUser,
      assistant({ sidechain: true, stop: 'tool_use', tool: 'Grep' })
    )
    expect(status).toBe('waiting-input')
  })

  it('survives corrupt and irrelevant lines', () => {
    const { status } = play(prompt(), '{not json', '', JSON.stringify({ type: 'mode' }))
    expect(status).toBe('working')
  })

  it('tracks the last tool name for the pill', () => {
    const { state } = play(prompt(), assistant({ stop: 'tool_use', tool: 'Edit' }))
    expect(state.lastTool).toBe('Edit')
  })
})

describe('ingest — token accounting', () => {
  const usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100 }

  it('accumulates all four buckets', () => {
    const { state } = play(
      assistant({ id: 'a', usage: { ...usage, cache_creation_input_tokens: 7 } })
    )
    expect(state.totals).toEqual({ input: 10, output: 5, cacheRead: 100, cacheCreate: 7 })
  })

  it('sums across distinct messages', () => {
    const { state } = play(
      assistant({ id: 'a', requestId: 'r1', usage }),
      assistant({ id: 'b', requestId: 'r2', usage })
    )
    expect(state.totals.output).toBe(10)
  })

  // Streaming rewrites the same message across several lines: last one wins,
  // and the earlier snapshot must be backed out rather than double-counted.
  it('lets the last copy of a message win', () => {
    const { state } = play(
      assistant({ id: 'a', requestId: 'r1', usage: { output_tokens: 5 } }),
      assistant({ id: 'a', requestId: 'r1', usage: { output_tokens: 40 } })
    )
    expect(state.totals.output).toBe(40)
  })

  // With no message.id the old key collapsed every line to "|", so each new
  // line subtracted the previous one's totals.
  it('counts identity-less lines once each instead of cancelling them', () => {
    const line = (out: number): string =>
      JSON.stringify({ type: 'assistant', message: { stop_reason: 'end_turn', usage: { output_tokens: out } } })
    const { state } = play(line(5), line(9))
    expect(state.totals.output).toBe(14)
  })

  it('tracks context from the main thread only', () => {
    const { state } = play(
      assistant({ id: 'a', usage: { input_tokens: 10, cache_read_input_tokens: 90 } }),
      assistant({ sidechain: true, id: 'b', usage: { input_tokens: 5000 } })
    )
    expect(state.contextTokens).toBe(100)
  })

  it('ignores synthetic error lines when tracking context', () => {
    const { state } = play(
      assistant({ id: 'a', usage: { input_tokens: 100 } }),
      assistant({ id: 'b', model: '<synthetic>', usage: { input_tokens: 1 } })
    )
    expect(state.contextTokens).toBe(100)
    expect(state.model).toBe('claude-opus-4-8')
  })

  // Sidechain usage is billed and belongs in totals, just not in context.
  it('still bills sidechain usage into totals', () => {
    const { state } = play(assistant({ sidechain: true, id: 'b', usage: { output_tokens: 30 } }))
    expect(state.totals.output).toBe(30)
  })
})
