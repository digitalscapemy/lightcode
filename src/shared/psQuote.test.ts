import { describe, expect, it } from 'vitest'
import { psNativeArgSafe, psSingleQuote } from './psQuote'

describe('psSingleQuote', () => {
  it('doubles the ASCII quote', () => {
    expect(psSingleQuote("it's")).toBe("'it''s'")
  })

  it('doubles every curly single quote PowerShell also accepts', () => {
    expect(psSingleQuote('don\u2019t')).toBe("'don\u2019\u2019t'")
    expect(psSingleQuote('\u2018a\u2019 \u201Ab\u201B')).toBe(
      "'\u2018\u2018a\u2019\u2019 \u201A\u201Ab\u201B\u201B'"
    )
  })

  it('leaves no lone quote character that could close the literal', () => {
    const quoted = psSingleQuote("x\u2019; Remove-Item C:\\ -Recurse; '")
    const inner = quoted.slice(1, -1)
    // every quote char inside comes in a doubled pair
    expect(inner.replace(/(['\u2018\u2019\u201A\u201B])\1/g, '')).not.toMatch(/['\u2018\u2019\u201A\u201B]/)
  })

  it('leaves double quotes and $ alone (inert inside single quotes)', () => {
    expect(psSingleQuote('say "hi" $env:X')).toBe(`'say "hi" $env:X'`)
  })
})

describe('psNativeArgSafe', () => {
  it('turns double quotes into curly ones, alternating open and close', () => {
    expect(psNativeArgSafe('say "hi" and "bye"')).toBe('say \u201Chi\u201D and \u201Cbye\u201D')
  })

  it('leaves no ASCII double quote for PowerShell 5.1 to split on', () => {
    const out = psNativeArgSafe('a b" --dangerously-skip-permissions "c d')
    expect(out).not.toContain('"')
    expect(out).toContain('--dangerously-skip-permissions')
  })

  it('keeps a trailing backslash away from the closing quote', () => {
    expect(psNativeArgSafe(String.raw`C:\dir\ `.trimEnd())).toBe(String.raw`C:\dir\ `)
    expect(psNativeArgSafe(String.raw`a\b`)).toBe(String.raw`a\b`)
  })

  it('leaves ordinary text alone', () => {
    expect(psNativeArgSafe("don't & go | now 50%")).toBe("don't & go | now 50%")
  })
})
