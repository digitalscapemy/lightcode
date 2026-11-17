# Contributing to Light Code

Thank you for helping. Light Code is a small project and every contribution counts: bug
reports, ideas, documentation, translations of the docs, and code.

## Ways to help

- **Report a bug**: [open an issue](https://github.com/digitalscapemy/lightcode/issues/new/choose).
  Say what you did, what you expected, what happened, and your OS and Light Code version
  (shown in the toolbar).
- **Suggest a feature**: start a thread in
  [Discussions, Ideas](https://github.com/digitalscapemy/lightcode/discussions) so others can
  weigh in before anyone writes code.
- **Ask a question**: Discussions, Q&A.
- **Write code**: pick an issue labelled `good first issue` or `help wanted`, comment that you
  are taking it, and open a pull request. For anything large, discuss the approach in the
  issue first; it saves you rework.

## Development setup

You need **Node.js 22.12 or newer** (`node -v`) and **Git**. Windows 10/11 or macOS 12+.

```sh
git clone https://github.com/digitalscapemy/lightcode.git
cd lightcode
npm install
npm run dev
```

`node-pty` ships prebuilt binaries, so a compiler is normally not needed. If npm falls back to
building it, install Visual Studio Build Tools (Desktop development with C++) on Windows or the
Xcode Command Line Tools on macOS.

Keep the `postinstall` script in `package.json`: Electron no longer downloads its binary on
install, and `electron-vite` needs it to be there.

| Command | What it does |
| --- | --- |
| `npm run dev` | Run with hot reload |
| `npm run typecheck` | TypeScript check for main and renderer |
| `npm test` | Unit tests (Vitest) |
| `npm run build` | Production build into `out/` |
| `npm run dist` | Installer for the platform you are on |

`npm run dist` only builds for the machine it runs on, because the main process is compiled
to architecture-specific V8 bytecode. Installers for every platform come from CI
(`.github/workflows/build.yml`).

## Project layout

```
src/shared     types, IPC contract and pure logic shared by every layer
src/main       main process: terminals (node-pty), transcript watcher, git, lc server, updater
src/preload    the contextBridge boundary (window.lightclaude)
src/renderer   the UI: tab bar, split panes, palette, dialogs, panels
docs/images    screenshots used by the README
```

Most logic lives in small pure modules with a `*.test.ts` file beside them. A few starting points:

| File | What it is |
| --- | --- |
| `src/renderer/src/app.ts` | tabs, panes, layouts and focus |
| `src/renderer/src/pane.ts` | one terminal pane |
| `src/renderer/src/commands.ts`, `palette.ts` | the command registry and palette |
| `src/renderer/src/keys.ts` | keyboard shortcuts and their labels |
| `src/renderer/src/ui/` | shared modal, toast, tooltip, icons, logo |
| `src/renderer/src/styles.css` | design tokens (`:root`) and all styles |
| `src/shared/agents.ts` | agent adapters (Claude Code, Codex, Gemini, shell) |
| `src/shared/tools.ts`, `guides.ts` | installable CLIs and the fix-it guides |
| `src/main/usageWatcher.ts`, `accountUsage.ts` | token usage from transcripts |
| `src/renderer/src/lcPolicy.ts` | what the `lc` CLI may do |

## House rules

These keep Light Code the tool it is. Pull requests are reviewed against them.

1. **Warn, never block.** A plain terminal must keep working exactly as before. New features are
   optional, and when something is risky Light Code warns rather than refuses. The exceptions
   protect the user from an agent (for example, not letting an agent answer a permission prompt).
2. **Never steal a terminal key.** App shortcuts use `Mod+Shift` or `Mod+Alt`. `Ctrl+C`, `Ctrl+K`,
   `Ctrl+R` and friends belong to the shell. Add new shortcuts to `SHORTCUT_KEYS` in `keys.ts`;
   a test checks every label really triggers its action.
3. **Flat and simple UI.** Use the design tokens in `styles.css`. No gradients, glows, blur or
   coloured border stripes. One accent colour; other colours only carry meaning (status).
4. **No em dashes in anything a user reads**: UI text, toasts, dialogs, `lc` output, the
   changelog and the docs. Use a comma, colon, full stop or parentheses.
5. **Terminal output is untrusted.** Never put text from a terminal, a transcript or a repository
   file into a shell command, a URL or `innerHTML` without the existing guards
   (`psSingleQuote`, `psNativeArgSafe`, `isSafeExternalUrl`, `textContent`).
6. **Measure performance changes.** If a change could cost frames with many panes open, say how
   you measured it in the pull request.

## Pull requests

- Keep each pull request to one change, with a clear title (`fix: ...`, `feat: ...`, `perf: ...`,
  `docs: ...`).
- Run `npm run typecheck` and `npm test` before pushing. Add or update tests for logic you change.
- For UI changes, include a screenshot.
- User-visible changes get a line in `src/shared/changelog.ts` under the next version.

## Releases (maintainers)

Pushing a `vX.Y.Z` tag builds Windows and macOS installers in GitHub Actions and publishes them,
with the auto-update feeds, to GitHub Releases.

1. Describe the release in `src/shared/changelog.ts`, newest entry first. The same notes appear in
   the About dialog, the GitHub release and the update notification.
2. Bump and tag in one step, so the version and the tag can never disagree:

   ```sh
   npm version minor -m "release v%s: what changed"   # patch | minor | major
   git push && git push --tags
   ```

Never edit the version in `package.json` by hand: a tag that disagrees with it ships an update
feed that advertises the old version, and installed apps never update. CI refuses such a tag.

Windows installs updates in place. macOS cannot, because the builds are not signed with an
Apple Developer ID; it notifies the user and opens the right `.dmg` instead.

## Code of Conduct

By taking part you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
