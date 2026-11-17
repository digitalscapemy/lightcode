import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import { RESULT_TAIL_BYTES, lastAssistantText, lastAssistantTextFrom } from './agentResult'

const user = (content: unknown, extra: object = {}): string =>
  JSON.stringify({ type: 'user', message: { content }, ...extra })
const assistant = (id: string, blocks: unknown[], extra: object = {}): string =>
  JSON.stringify({ type: 'assistant', message: { id, content: blocks }, ...extra })
const text = (t: string): { type: string; text: string } => ({ type: 'text', text: t })
const toolUse = { type: 'tool_use', name: 'Bash', input: {} }
const toolResult = [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }]

describe('lastAssistantTextFrom', () => {
  it('returns the final message of the last turn, past its tool calls', () => {
    const lines = [
      user('first question'),
      assistant('m1', [text('first answer')]),
      user('second question'),
      assistant('m2', [text('Let me look at the tests.'), toolUse]),
      user(toolResult),
      assistant('m3', [toolUse]),
      user(toolResult),
      assistant('m4', [text('All 12 tests pass.')])
    ]
    expect(lastAssistantTextFrom(lines)).toBe('All 12 tests pass.')
  })

  // A tool result is a user line, and taking it for a new question would cut
  // the answer off at the agent's last tool call.
  it('does not mistake a tool result for a new question', () => {
    const lines = [user('q'), assistant('m1', [text('working on it'), toolUse]), user(toolResult)]
    expect(lastAssistantTextFrom(lines)).toBe('working on it')
  })

  it('joins a message streamed over several lines', () => {
    const lines = [user('q'), assistant('m1', [text('part one')]), assistant('m1', [text('part two')])]
    expect(lastAssistantTextFrom(lines)).toBe('part one\n\npart two')
  })

  it("ignores a subagent's lines", () => {
    const lines = [
      user('q'),
      assistant('m1', [text('the answer')]),
      assistant('s1', [text('subagent musing')], { isSidechain: true })
    ]
    expect(lastAssistantTextFrom(lines)).toBe('the answer')
  })

  it('says nothing when the turn has not answered in words yet', () => {
    expect(lastAssistantTextFrom([user('q'), assistant('m1', [toolUse])])).toBeNull()
    expect(lastAssistantTextFrom([])).toBeNull()
  })

  it('skips a line cut off mid-write', () => {
    const lines = [user('q'), assistant('m1', [text('done')]), '{"type":"assistant","message":{"id":"m2","con']
    expect(lastAssistantTextFrom(lines)).toBe('done')
  })
})

describe('lastAssistantText', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lc-result-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('reads the answer from a transcript file', async () => {
    const file = join(dir, 'a.jsonl')
    writeFileSync(file, [user('q'), assistant('m1', [text('42')])].join('\n') + '\n')
    expect(await lastAssistantText(file)).toBe('42')
  })

  it('reads only the tail of a long transcript, and still finds the answer', async () => {
    const file = join(dir, 'long.jsonl')
    const filler = assistant('old', [text('x'.repeat(1000))])
    const lines = Array.from({ length: Math.ceil((RESULT_TAIL_BYTES * 2) / filler.length) }, () => filler)
    writeFileSync(file, [...lines, user('q'), assistant('m1', [text('the end')])].join('\n'))
    expect(await lastAssistantText(file)).toBe('the end')
  })

  it('answers null, never throws, for a missing file', async () => {
    await expect(lastAssistantText(join(dir, 'nope.jsonl'))).resolves.toBeNull()
  })
})
