import { describe, expect, it } from 'vitest'
import { psSingleQuote } from './psQuote'

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
