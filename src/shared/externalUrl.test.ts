import { describe, expect, it } from 'vitest'
import { findUrls, isSafeExternalUrl } from './externalUrl'

describe('isSafeExternalUrl', () => {
  it('lets the web and mail out', () => {
    for (const u of ['https://github.com/x', 'http://localhost:3000/a?b=1', 'mailto:a@b.co']) {
      expect(isSafeExternalUrl(u)).toBe(true)
    }
  })

  it('refuses anything that would launch something local', () => {
    for (const u of [
      'file:///C:/Windows/System32/calc.exe',
      'javascript:alert(1)',
      'ms-settings:privacy',
      'vscode://file/c:/x',
      'smb://host/share',
      'not a url',
      '',
      42
    ]) {
      expect(isSafeExternalUrl(u)).toBe(false)
    }
  })
})

describe('findUrls', () => {
  it('finds a plain URL and where it starts', () => {
    expect(findUrls('see https://example.com/a for more')).toEqual([
      { url: 'https://example.com/a', start: 4 }
    ])
  })

  it('leaves sentence punctuation and unbalanced brackets off', () => {
    expect(findUrls('Done: https://x.y/z.').map((u) => u.url)).toEqual(['https://x.y/z'])
    expect(findUrls('(see https://x.y/z)').map((u) => u.url)).toEqual(['https://x.y/z'])
    expect(findUrls('https://en.wikipedia.org/wiki/A_(b)').map((u) => u.url)).toEqual([
      'https://en.wikipedia.org/wiki/A_(b)'
    ])
  })

  it('finds several on one line', () => {
    expect(findUrls('a http://a.io b https://b.io/c').map((u) => u.url)).toEqual([
      'http://a.io',
      'https://b.io/c'
    ])
  })

  it('ignores other schemes', () => {
    expect(findUrls('file:///etc/passwd ftp://x.y')).toEqual([])
  })
})
