import { createRequire } from 'module'
import { readFileSync } from 'fs'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { SOURCE, readChangelog, entryFor } = require('./changelog.cjs')

const source: string = readFileSync(SOURCE, 'utf8')
const pkgVersion: string = require('../package.json').version

describe('readChangelog', () => {
  it('reads the real file the app ships', () => {
    const entries = readChangelog()
    expect(entries.length).toBeGreaterThan(0)
    expect(entries[0]).toHaveProperty('version')
    expect(entries[0].notes.length).toBeGreaterThan(0)
  })

  /**
   * The regression this file exists for. Windows runners check the repo out
   * with CRLF; the interface strip anchors on \n, so without normalising first
   * `export interface` survives and `new Function` throws "Unexpected token
   * 'export'". The v0.4.1 Windows build died exactly there while both macOS
   * builds passed — the failure cannot reproduce on the machine it is written
   * on, which is what makes it worth pinning.
   */
  it('parses a CRLF checkout identically to an LF one', () => {
    // Both fixtures are built from a normalised copy rather than from the
    // file as it sits on disk. Reading it raw meant the two were identical on
    // a Windows checkout — where the file is already CRLF — so the very test
    // written to catch a Windows-only bug failed on Windows and nowhere else.
    const lf = source.replace(/\r\n/g, '\n')
    const crlf = lf.replace(/\n/g, '\r\n')
    expect(crlf).not.toBe(lf) // the fixture must actually differ
    expect(readChangelog(crlf)).toEqual(readChangelog(lf))
  })

  it('survives a checkout with no trailing newline', () => {
    expect(readChangelog(source.trimEnd())).toEqual(readChangelog(source))
  })
})

describe('entryFor', () => {
  it('finds the version being shipped, so a release is never noteless', () => {
    // Fails loudly when a version is bumped and the changelog entry forgotten:
    // that ships a release whose notification has nothing to say.
    expect(entryFor(pkgVersion)).toBeDefined()
  })

  it('returns undefined for a version with no entry', () => {
    expect(entryFor('99.99.99')).toBeUndefined()
  })
})
