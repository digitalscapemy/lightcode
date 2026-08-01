// The one reader of src/shared/changelog.ts outside the app itself.
//
// Three places quote those notes and none of them may disagree: the in-app
// About dialog (which imports the TypeScript directly), the GitHub release
// body, and the update notification other people see. The last two come
// through here.
const fs = require('fs')
const path = require('path')

const SOURCE = path.join(__dirname, '..', 'src', 'shared', 'changelog.ts')

/**
 * Every changelog entry, newest first.
 *
 * Strips the TypeScript and evaluates what is left — the file is otherwise
 * plain JS, which is far more robust than pattern-matching note strings out
 * of it.
 *
 * The CRLF normalisation is load-bearing, not tidiness: Windows checks the
 * repo out with CRLF, the interface strip below anchors on \n, and without it
 * `export interface` survives, `new Function` throws "Unexpected token
 * 'export'", and the Windows release build dies while both macOS builds pass.
 * That is exactly how v0.4.1 failed.
 */
function readChangelog(source) {
  const js = (source ?? fs.readFileSync(SOURCE, 'utf8'))
    .replace(/\r\n/g, '\n')
    .replace(/export interface[\s\S]*?\n}\n/, '')
    .replace(/:\s*ChangelogEntry\[\]/, '')
    .replace(/export const/g, 'const')
  return new Function(`${js}; return CHANGELOG`)()
}

/** The entry for one version, or undefined when that version has none. */
function entryFor(version, source) {
  return readChangelog(source).find((e) => e.version === version)
}

module.exports = { SOURCE, readChangelog, entryFor }
