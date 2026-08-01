// Writes build/release-notes.md for the version in package.json, taken from the
// hand-written notes in src/shared/changelog.ts.
//
// electron-builder picks that file up by name on its own (buildResources is
// `build`, and getReleaseInfo falls back to "release-notes.md") and embeds its
// contents into latest.yml / latest-mac.yml as `releaseNotes`. electron-updater
// then hands them to the app as UpdateInfo.releaseNotes, which is what lets the
// update toast say WHAT changed — an app can never know that on its own, since
// its own changelog was compiled in before the newer version existed.
//
// Generated rather than hand-maintained so the About dialog, the GitHub release
// body and the update toast can never drift apart: one source, three readers.
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')
const version = require(path.join(root, 'package.json')).version

// Strip the TypeScript and evaluate — the file is otherwise plain JS, which is
// far more robust than pattern-matching note strings out of it. Same approach
// the release workflow uses to build the GitHub release body.
const js = fs
  .readFileSync(path.join(root, 'src/shared/changelog.ts'), 'utf8')
  .replace(/export interface[\s\S]*?\n}\n/, '')
  .replace(/:\s*ChangelogEntry\[\]/, '')
  .replace(/export const/g, 'const')

const entry = new Function(`${js}; return CHANGELOG`)().find((e) => e.version === version)

const out = path.join(root, 'build/release-notes.md')
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
