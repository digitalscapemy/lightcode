/**
 * What a pane must not inherit from whatever started Light Code.
 *
 * Started from inside a Claude Code session (`! npm run dev`, or a Claude that
 * opened the app), Light Code inherits that session's markers, and so would
 * every pane. A `claude` run in one then believes it is a child of that outer
 * session: it turns transcript saving off ("inherited CLAUDE_CODE_CHILD_SESSION
 * marker"), which also blinds Light Code's own status and usage, and it may
 * talk to the outer session's messaging pipe.
 *
 * Only the markers of a running session go. Settings a person chose for Claude
 * Code (CLAUDE_CONFIG_DIR, CLAUDE_CODE_GIT_BASH_PATH, CLAUDE_CODE_USE_BEDROCK,
 * …) are theirs and stay.
 */
export const CLAUDE_SESSION_ENV: readonly string[] = [
  'CLAUDECODE',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_PID',
  'CLAUDE_EFFORT'
]

/** A copy of `env` without the outer Claude session's markers. Case-insensitive, as Windows is. */
export function withoutClaudeSession(env: Record<string, string>): Record<string, string> {
  const drop = new Set(CLAUDE_SESSION_ENV.map((k) => k.toUpperCase()))
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) if (!drop.has(k.toUpperCase())) out[k] = v
  return out
}
