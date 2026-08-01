// Writes build/release-notes.md for the version in package.json, taken from the
// hand-written notes in src/shared/changelog.ts.
//
// electron-builder picks that file up by name on its own (buildResources is
// `build`, and getReleaseInfo falls back to "release-notes.md") and embeds its
// contents into latest.yml / latest-mac.yml as `releaseNotes`. electron-updater
// then hands them to the app as UpdateInfo.releaseNotes, which is what lets the
// update notification say WHAT changed — an app can never know that on its own,
// since its own changelog was compiled in before the newer version existed.
const fs = require('fs')
const path = require('path')
const { entryFor } = require('./changelog.cjs')

const root = path.join(__dirname, '..')
const version = require(path.join(root, 'package.json')).version
const entry = entryFor(version)

const out = path.join(root, 'build', 'release-notes.md')
if (!entry) {
  // Not fatal: a release with no notes still updates correctly, it just offers
  // the user nothing to read. Remove any stale file so the previous version's
  // notes are never shipped as if they described this one.
  fs.rmSync(out, { force: true })
  console.warn(`[release-notes] no CHANGELOG entry for ${version} — shipping none`)
  process.exit(0)
}

fs.writeFileSync(out, entry.notes.map((n) => `- ${n}`).join('\n') + '\n')
console.log(`[release-notes] ${version}: ${entry.notes.length} note(s) -> build/release-notes.md`)
