import { describe, expect, it } from 'vitest'
import { parseNotes } from './releaseNotes'

/**
 * These notes reach the update toast from the network, and the toast is the
 * only place a user can read what they are agreeing to install. Both shapes
 * are pinned here: the markdown we embed ourselves, and the HTML release body
 * electron-updater falls back to for releases that predate the embedding.
 */

describe('parseNotes — the embedded markdown (normal path)', () => {
  it('turns bullets into one plain line each', () => {
    expect(parseNotes('- Drag files in\n- Mac picks its own installer\n')).toEqual([
      'Drag files in',
      'Mac picks its own installer'
    ])
  })

  it('accepts * as a bullet marker too', () => {
    expect(parseNotes('* One\n* Two')).toEqual(['One', 'Two'])
  })

  it('keeps prose that merely contains a dash', () => {
    expect(parseNotes('- Quoted — only when the shell needs it')).toEqual([
      'Quoted — only when the shell needs it'
    ])
  })
})

describe('parseNotes — the GitHub release body (fallback path)', () => {
  it('strips tags rather than showing them as text', () => {
    expect(parseNotes('<ul><li>Drag files in</li><li>Faster startup</li></ul>')).toEqual([
      'Drag files in',
      'Faster startup'
    ])
  })

  it('drops the download table and headings in raw markdown', () => {
    const body = [
      '### Download',
      '| Your machine | File |',
      '| --- | --- |',
      '| Windows 10/11 | LightCode-Setup.exe |',
      '',
      "### What's new in 0.4.1",
      '- The update notification says what changed'
    ].join('\n')
    expect(parseNotes(body)).toEqual(['The update notification says what changed'])
  })

  /**
   * Regression, and the reason any of this is here: the shape below is copied
   * from https://github.com/digitalscapemy/lightcode/releases.atom for v0.4.0.
   * A real update against it put the download table's cells in the toast —
   * "Your machine", "File", "Windows 10/11" — because the `|`-prefix filter
   * only ever saw markdown, and GitHub serves the table already rendered.
   */
  it('drops the download table once GitHub has rendered it to <td>s', () => {
    const body =
      '<h3>Download</h3>\n' +
      '<table><thead><tr><th>Your machine</th><th>File</th></tr></thead>\n' +
      '<tbody><tr><td>Windows 10/11</td><td><a href="…"><code>LightCode-Setup.exe</code></a></td></tr>\n' +
      '<tr><td>Mac — Intel</td><td><a href="…"><code>LightCode-x64.dmg</code></a></td></tr></tbody></table>\n' +
      '<p>Not sure which Mac you have? <strong>Apple menu → About This Mac</strong></p>\n' +
      "<h3>What's new in 0.4.0</h3>\n" +
      '<ul>\n<li>Drag a file or folder onto a pane and its path is typed at the prompt.</li>\n' +
      '<li>Updating on macOS goes straight to the installer your Mac can run.</li>\n</ul>'
    expect(parseNotes(body)).toEqual([
      'Drag a file or folder onto a pane and its path is typed at the prompt.',
      'Updating on macOS goes straight to the installer your Mac can run.'
    ])
  })

  it('keeps a wrapped list item as ONE note, not one per line', () => {
    const body = '<ul><li>Drag a file onto a pane\n   and its path is typed\n   at the prompt.</li></ul>'
    expect(parseNotes(body)).toEqual(['Drag a file onto a pane and its path is typed at the prompt.'])
  })

  it('falls back to the prose when a body has no list at all', () => {
    const body =
      '<h3>Download</h3><table><tr><td>Windows 10/11</td></tr></table>' +
      '<p>Security fix for the terminal.</p><pre><code>xattr -cr app</code></pre>'
    expect(parseNotes(body)).toEqual(['Security fix for the terminal.'])
  })

  it('decodes entities so quotes and ampersands read as written', () => {
    expect(parseNotes('<p>Drag &amp; drop &quot;My File&quot; &#39;now&#39;</p>')).toEqual([
      'Drag & drop "My File" \'now\''
    ])
  })

  it("does not double-decode — &amp;lt; is the text '&lt;', not a tag", () => {
    expect(parseNotes('&amp;lt;script&amp;gt;')).toEqual(['&lt;script&gt;'])
  })

  it('accepts the per-version array shape', () => {
    expect(parseNotes([{ note: '<p>First</p>' }, { note: 'Second' }])).toEqual(['First', 'Second'])
  })
})

describe('parseNotes — nothing to show', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['empty string', ''],
    ['whitespace only', '\n  \n'],
    ['markup with no text', '<p></p><ul></ul>']
  ])('returns [] for %s, so the toast simply omits the list', (_name, raw) => {
    expect(parseNotes(raw as string | null | undefined)).toEqual([])
  })

  it('tolerates a null note inside the array', () => {
    expect(parseNotes([{ note: null }, { note: 'Kept' }])).toEqual(['Kept'])
  })
})

describe('parseNotes — length', () => {
  it('caps at 8: a toast is not a changelog viewer', () => {
    const many = Array.from({ length: 20 }, (_, i) => `- note ${i}`).join('\n')
    const notes = parseNotes(many)
    expect(notes).toHaveLength(8)
    expect(notes[0]).toBe('note 0')
  })
})
