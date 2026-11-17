import { describe, expect, it } from 'vitest'
import { accountTarget, isInside, isValidCategory, joinPath, projectTarget } from './shortcutPaths'

describe('joinPath', () => {
  it('joins without doubling separators', () => {
    expect(joinPath('\\', 'C:\\Projects\\', '\\Web', 'shop')).toBe('C:\\Projects\\Web\\shop')
    expect(joinPath('/', '/home/me/', 'work')).toBe('/home/me/work')
  })

  it('keeps a bare drive root', () => {
    expect(joinPath('\\', 'C:\\', 'shop')).toBe('C:\\shop')
    expect(joinPath('/', '/', 'shop')).toBe('/shop')
  })
})

describe('projectTarget / accountTarget', () => {
  it('puts the project under its category', () => {
    expect(projectTarget('C:\\Projects', 'Software', 'lightcode', '\\')).toBe(
      'C:\\Projects\\Software\\lightcode'
    )
  })

  it('goes straight under the root without a category', () => {
    expect(projectTarget('C:\\Projects', undefined, 'lightcode', '\\')).toBe('C:\\Projects\\lightcode')
    expect(projectTarget('C:\\Projects', '', 'lightcode', '\\')).toBe('C:\\Projects\\lightcode')
  })

  it('names the account dir .claude-<name>', () => {
    expect(accountTarget('C:\\Users\\me', 'work', '\\')).toBe('C:\\Users\\me\\.claude-work')
    expect(accountTarget('/Users/me', 'work', '/')).toBe('/Users/me/.claude-work')
  })
})

describe('isValidCategory', () => {
  it.each(['Software', 'Client Work', 'web-2026', 'Ä'])('accepts %s', (c) => {
    expect(isValidCategory(c)).toBe(true)
  })

  it.each(['', ' ', ' Web', 'a/b', 'a\\b', 'a:b', 'what?', 'end.', 'end ', '..', 'CON', 'lpt1'])(
    'rejects %j',
    (c) => {
      expect(isValidCategory(c)).toBe(false)
    }
  )
})

describe('isInside', () => {
  it('matches children, not the root or siblings', () => {
    expect(isInside('C:\\Projects', 'C:\\Projects\\Web\\shop', true)).toBe(true)
    expect(isInside('C:\\Projects', 'c:/projects/web', true)).toBe(true)
    expect(isInside('C:\\Projects', 'C:\\Projects', true)).toBe(false)
    expect(isInside('C:\\Projects', 'C:\\ProjectsOld\\x', true)).toBe(false)
    expect(isInside('C:\\Projects', 'C:\\Projects\\..\\Windows', true)).toBe(false)
    expect(isInside('/home/me', '/home/Me/x', false)).toBe(false)
  })
})
