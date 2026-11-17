import { describe, expect, it } from 'vitest'
import { approvalResolved, deriveStatus, emptyFileState, ingest, statusFor } from './usageWatcher'
import type { Approval, FileState } from './usageWatcher'

/**
 * The dot is exactly `deriveStatus(fold(ingest, lines))` — no timers, no
 * clock. These tests pin the turn-state machine that replaced the old
 * "silent for 4s ⇒ not working" heuristic, which was wrong ~30% of the time
 * because the transcript is silent *precisely while* work happens.
 */

const prompt = (text = 'hi'): string =>
  JSON.stringify({ type: 'user', message: { role: 'user', content: text } })

const toolResult = (id?: string): string =>
  JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', content: 'ok', ...(id ? { tool_use_id: id } : {}) }]
    }
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

describe('deriveStatus, turn state', () => {
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

  it('never reports waiting-approval, the transcript cannot know', () => {
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

/**
 * A tool_result is proof its tool ran, which is the only honest way to know a
 * permission prompt was answered — the prompt itself leaves no trace at all
 * (see the note on PaneStatus in shared/ipc.ts). The hook reports the prompt;
 * these counters are what retire it.
 */
describe('ingest, tool results, for retiring a permission prompt', () => {
  it('counts nothing before any tool has run', () => {
    const { state } = play(prompt(), assistant({ stop: 'tool_use', tool: 'Bash' }))
    expect(state.toolResults).toBe(0)
  })

  it('counts every result', () => {
    const { state } = play(
      prompt(),
      assistant({ stop: 'tool_use', tool: 'Bash' }),
      toolResult('toolu_1'),
      toolResult('toolu_2')
    )
    expect(state.toolResults).toBe(2)
  })

  // The hook does not name the call it is guarding, so an id-less result has to
  // count exactly the same as one carrying an id.
  it('still counts a result that carries no id', () => {
    const { state } = play(prompt(), toolResult())
    expect(state.toolResults).toBe(1)
  })

  it('counts several results inside one message', () => {
    const batch = JSON.stringify({
      type: 'user',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 'a' },
          { type: 'tool_result', tool_use_id: 'b' },
          { type: 'tool_result', tool_use_id: 'c' }
        ]
      }
    })
    const { state } = play(prompt(), batch)
    expect(state.toolResults).toBe(3)
  })

  // Sidechain results belong to a subagent's own tool calls, not to a prompt
  // the user is looking at.
  it('ignores sidechain results', () => {
    const side = JSON.stringify({
      type: 'user',
      isSidechain: true,
      message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_x' }] }
    })
    const { state } = play(prompt(), side)
    expect(state.toolResults).toBe(0)
  })

  it('keeps counting across a long session', () => {
    const lines = Array.from({ length: 200 }, (_, i) => toolResult(`toolu_${i}`))
    const { state } = play(prompt(), ...lines)
    expect(state.toolResults).toBe(200)
  })
})

/**
 * When the red dot goes out. Measured against Claude Code 2.1.226:
 * PermissionRequest names the tool but not the call (`tool_name`, no
 * `tool_use_id`), so a prompt cannot be matched to what it guards. Every answer
 * does append one tool_result though — approved or denied — so the rule is
 * arithmetic: as many answers as questions.
 */
describe('approvalResolved, retiring the red dot', () => {
  const pending = (over: Partial<Approval> = {}): Approval => ({
    toolName: 'Write',
    results: 0,
    outstanding: 1,
    ...over
  })

  const withResults = (n: number): FileState => {
    const state = emptyFileState()
    state.toolResults = n
    return state
  }

  it('holds while nothing has been answered', () => {
    expect(approvalResolved(pending(), withResults(0))).toBe(false)
  })

  it('retires once the answer lands', () => {
    expect(approvalResolved(pending(), withResults(1))).toBe(true)
  })

  it('counts from where the prompt appeared, not from zero', () => {
    const p = pending({ results: 7 })
    expect(approvalResolved(p, withResults(7))).toBe(false)
    expect(approvalResolved(p, withResults(8))).toBe(true)
  })

  // The batch case, and the reason `outstanding` exists: three prompts from one
  // parallel tool batch must not be retired by the first result.
  it('waits for every prompt in a batch', () => {
    const p = pending({ outstanding: 3 })
    expect(approvalResolved(p, withResults(1))).toBe(false)
    expect(approvalResolved(p, withResults(2))).toBe(false)
    expect(approvalResolved(p, withResults(3))).toBe(true)
  })

  // A Notification-only prompt is never counted, since it fires alongside the
  // request it accompanies. It retires on any answer at all.
  it('treats an uncounted prompt as needing one answer', () => {
    const p = pending({ outstanding: 0 })
    expect(approvalResolved(p, withResults(0))).toBe(false)
    expect(approvalResolved(p, withResults(1))).toBe(true)
  })

  // A prompt is on screen and no transcript has been read: nothing can have
  // answered it, so the dot must stay lit.
  it('holds when there is no transcript yet', () => {
    expect(approvalResolved(pending(), undefined)).toBe(false)
  })

  it('stays retired once more answers arrive than were asked for', () => {
    expect(approvalResolved(pending({ outstanding: 2 }), withResults(9))).toBe(true)
  })
})

/**
 * The precedence rule, which is where the hook signals and the transcript meet.
 */
describe('statusFor, hooks over inference', () => {
  const prompting: Approval = { toolName: 'Write', results: 0, outstanding: 1 }

  /** A transcript mid-turn: inference alone would call this `working`. */
  const midTurn = (): FileState => {
    const s = emptyFileState()
    ingest(s, JSON.stringify({ type: 'user', message: { content: 'go' } }))
    return s
  }

  it('falls through to the transcript when no hook has spoken', () => {
    expect(statusFor(undefined, undefined, midTurn())).toBe('working')
  })

  it('shows an unanswered prompt above everything else', () => {
    expect(statusFor(prompting, 'working', midTurn())).toBe('waiting-approval')
  })

  // The bug this rule exists for: rejecting every tool in a turn leaves the
  // transcript ending on a tool_result, which reads as a turn starting. Without
  // the hook's word the pane shows a busy pill for a Claude that has stopped.
  it('does not let a trailing tool_result re-open a turn the hook ended', () => {
    const state = midTurn()
    ingest(state, JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result' }] } }))
    expect(deriveStatus(state)).toBe('working') // what inference alone believes
    expect(statusFor(undefined, 'ended', state)).toBe('waiting-input')
  })

  it('lets an answered prompt fall through to the ended turn', () => {
    const state = midTurn()
    state.toolResults = 1 // the rejection or the run itself
    expect(statusFor(prompting, 'ended', state)).toBe('waiting-input')
  })

  // While the hook says a turn is running, the transcript may still end it, so a
  // dropped Stop envelope cannot freeze a pane on `working` for ever.
  it('still lets the transcript end a turn the hook thinks is running', () => {
    const state = emptyFileState()
    ingest(state, JSON.stringify({ type: 'user', message: { content: 'go' } }))
    ingest(
      state,
      JSON.stringify({ type: 'assistant', message: { id: 'm', stop_reason: 'end_turn' } })
    )
    expect(statusFor(undefined, 'working', state)).toBe('waiting-input')
  })
})

describe('ingest, token accounting', () => {
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
