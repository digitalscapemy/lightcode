import { open } from 'fs/promises'

/**
 * A Claude pane's last answer, read from its transcript: `lc result`.
 *
 * The screen is the agent's interface, not its answer — wrapped to the pane's
 * width, framed, half of it scrolled away — and an orchestrator that scrapes it
 * gets a worse copy of something the transcript holds verbatim. So the answer
 * comes from the transcript: the text of the last assistant message after the
 * last thing a person (or `lc`) typed.
 */

/** How much of the end of a transcript is read. One answer fits many times over. */
export const RESULT_TAIL_BYTES = 256 * 1024

interface Line {
  type?: string
  isSidechain?: boolean
  isMeta?: boolean
  message?: {
    id?: string
    content?: string | { type?: string; text?: string }[]
  }
}

function parse(line: string): Line | null {
  try {
    const obj = JSON.parse(line) as unknown
    return typeof obj === 'object' && obj !== null ? (obj as Line) : null
  } catch {
    return null // the partial first line of a tail, or a write still landing
  }
}

/**
 * A user line that is somebody typing, as opposed to a tool's result being fed
 * back mid-turn. Those arrive as user lines too, and counting one as a new
 * question would cut the answer off at the agent's last tool call.
 */
function isPrompt(obj: Line): boolean {
  if (obj.type !== 'user' || obj.isSidechain === true || obj.isMeta === true) return false
  const content = obj.message?.content
  if (typeof content === 'string') return true
  return Array.isArray(content) && !content.some((b) => b?.type === 'tool_result')
}

/**
 * The answer in some transcript lines, oldest first. Pure; see the file note.
 *
 * Main-thread assistant messages only — a subagent's lines are its own
 * working, not the answer. A message streamed over several lines shares its
 * id, so the last message's text blocks are joined; an earlier message in the
 * same turn ("let me look at the tests…") is narration, not the answer. Null
 * when the turn has said nothing in words yet.
 */
export function lastAssistantTextFrom(lines: string[]): string | null {
  const parsed = lines.map(parse)
  let start = 0
  for (let i = parsed.length - 1; i >= 0; i--) {
    const obj = parsed[i]
    if (obj && isPrompt(obj)) {
      start = i + 1
      break
    }
  }
  let lastId: string | undefined
  let parts: string[] = []
  for (let i = start; i < parsed.length; i++) {
    const obj = parsed[i]
    if (!obj || obj.type !== 'assistant' || obj.isSidechain === true) continue
    const content = obj.message?.content
    const texts =
      typeof content === 'string'
        ? [content]
        : Array.isArray(content)
          ? content.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text!)
          : []
    const words = texts.map((t) => t.trim()).filter((t) => t !== '')
    if (words.length === 0) continue
    const id = obj.message?.id
    if (id !== undefined && id === lastId) parts.push(...words)
    else parts = words
    lastId = id
  }
  return parts.length === 0 ? null : parts.join('\n\n')
}

/**
 * The last answer in a transcript file, or null. Reads only the tail, and
 * never throws: a transcript that is missing, unreadable or mid-write is an
 * answer of "nothing to say", and the caller falls back to the screen.
 */
export async function lastAssistantText(file: string): Promise<string | null> {
  let handle: Awaited<ReturnType<typeof open>> | null = null
  try {
    handle = await open(file, 'r')
    const { size } = await handle.stat()
    const length = Math.min(size, RESULT_TAIL_BYTES)
    const buf = Buffer.alloc(length)
    await handle.read(buf, 0, length, size - length)
    const lines = buf.toString('utf8').split('\n')
    // Started mid-file: the first line is the back half of one, and parse()
    // would drop it anyway — but it could be the back half of a line that
    // happens to parse, so it goes regardless.
    if (length < size) lines.shift()
    return lastAssistantTextFrom(lines.filter((l) => l.trim() !== ''))
  } catch {
    return null
  } finally {
    await handle?.close().catch(() => {})
  }
}
