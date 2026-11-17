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
