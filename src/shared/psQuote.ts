/**
 * Every character PowerShell accepts as a single quote. Its tokenizer treats
 * the curly ones (‘ ’ ‚ ‛) exactly like ', so a string escaped for ' alone is
 * closed early by a "don’t" — and whatever follows runs as code. AI-written
 * prompts are full of ’, which made this both a breakage and an injection.
 */
const PS_SINGLE_QUOTES = /['‘’‚‛]/g

/**
 * Quote a value as a PowerShell single-quoted string literal. Doubling any of
 * the quote characters yields that exact character, so the value round-trips
 * unchanged — which matters for paths as much as for prompts.
 */
export function psSingleQuote(value: string): string {
  return `'${value.replace(PS_SINGLE_QUOTES, (c) => c + c)}'`
}

/**
 * Make free text safe to hand to a native program (claude.exe, codex.exe)
 * as ONE argument from Windows PowerShell 5.1.
 *
 * Quoting the PowerShell literal correctly is not enough. When 5.1 builds the
 * child's command line it wraps an argument in "…" without escaping the `"`
 * inside it, so the program's own parser splits it: measured,
 * `a b" --dangerously-skip-permissions "c d` arrived as three arguments, the
 * middle one a real flag. A trailing backslash escapes the closing quote the
 * same way. PowerShell 7.3+ gets this right for .exe files but not for .cmd
 * shims (npm installs), so it is fixed here, for every version.
 *
 * `"` becomes “ / ” in turn — to an agent reading a prompt they mean the same —
 * and a trailing run of backslashes gets a space so it cannot reach the quote.
 * Backslashes elsewhere are literal once no `"` follows them.
 *
 * And it always contains whitespace. PowerShell only wraps an argument in "…"
 * when it has some, and an npm-installed agent is a .cmd shim that cmd.exe
 * parses: measured, a bare `a&whoami` ran whoami. Inside the quotes — which no
 * `"` of ours can now close — cmd treats & | < > as text. So text with no
 * whitespace gets a trailing space, which no agent reads as anything.
 */
export function psNativeArgSafe(text: string): string {
  let open = true
  const swapped = text.replace(/"/g, () => {
    const c = open ? '“' : '”'
    open = !open
    return c
  })
  return /\\$/.test(swapped) || !/\s/.test(swapped) ? `${swapped} ` : swapped
}
