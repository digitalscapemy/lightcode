<div align="center">

<img src="src/renderer/public/logo.png" alt="Light Code" width="96" />

# Light Code

**A lightweight multi-terminal manager built for Claude Code power users.**

Run many Claude Code sessions side by side — with real-time token usage on every pane,
multi-account switching, project shortcuts, and a terminal that stays out of your way.

[![Latest release](https://img.shields.io/github/v/release/digitalscapemy/lightcode?label=release)](https://github.com/digitalscapemy/lightcode/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS-lightgrey)

[Download](https://github.com/digitalscapemy/lightcode/releases/latest) ·
[Features](#features) ·
[Keyboard shortcuts](#keyboard-shortcuts) ·
[Build from source](#build-from-source)

</div>

---

## Why Light Code?

Running one Claude Code session is easy. Running **six of them across four projects with two
accounts** is where normal terminals fall apart — you lose track of which pane is which project,
which account is burning quota, and how close each session is to filling its context window.

Light Code is a purpose-built cockpit for that workflow: every pane knows its project, its
Claude session, and its token usage — live.

## Features

### 🔢 Real-time token usage, per pane
The headline feature. Each pane shows a live badge with the **actual token usage** of the Claude
Code session running in it — read directly from Claude Code's own session transcripts, not
estimated:

- **Session total** — cumulative input/output/cache tokens (hover for the full breakdown)
- **Context fill** — how full the model's context window is (e.g. `87k/1M`), with the window
  size detected from the model the session is actually using
- **Per-pane attribution** — six panes, six sessions, six independent badges; sessions started
  outside the app never pollute your numbers
- Updates live while Claude streams, with negligible overhead (incremental transcript tailing)

### 👥 Multi-account Claude switching
Run different Claude accounts in different panes. Define account shortcuts (e.g. `claude1`,
`claude2`) that launch Claude Code with a dedicated `CLAUDE_CONFIG_DIR` — and the token badges
track every account's sessions correctly.

### ⚡ Shortcuts Manager
Manage project and account shortcuts from the UI instead of hand-editing your shell profile:

- **Project shortcuts** — type `myproject` in any terminal to jump straight to its folder
- **Account shortcuts** — type `claude2` to run Claude Code under another account
- Written to your shell profile (PowerShell on Windows, zsh/bash on macOS) inside a clearly
  marked managed block — your existing profile content is never touched
- One-click **import** of shortcuts you already have in your profile
- Works in *any* terminal, not just Light Code

### 🗂 Tabs & split panes
- Each tab is a project; split panes right/down (`Ctrl/Cmd+Shift+E` / `D`), drag dividers,
  maximize a pane, drag-reorder tabs
- **Layout picker** (grid button in the tab bar) — pick a pane arrangement from a visual
  grid instead of splitting one pane at a time: 2 columns, 2×2, 3×2, 4×4 and more, up to 16
  panes. Switching layouts **keeps every running session alive** — panes are rearranged, not
  restarted. Shrinking to a smaller layout closes the extra panes, so it asks first.
- **Open several tabs at once** — right-click the `+` button to add 3, 8 or 16 tabs in one go
- **Adjustable text size** (`Ctrl/Cmd` `+` / `-` / `0`) — shrink the terminal font to fit a dense
  layout on screen, or grow it back. Applies to every pane and survives restarts.
- Rename tabs (double-click) and panes (⋮ menu) — names survive restarts
- **Working-directory memory**: shell integration tracks every `cd` live, and each pane reopens
  in its last folder after a restart. New splits open in the source pane's current folder.

### 📸 Paste screenshots into Claude
Snip something (`Win+Shift+S` / `Cmd+Shift+4`), press `Ctrl/Cmd+V` in the terminal — the image
is saved to a temp file and its path is pasted, ready for Claude Code to read. Plain text pastes
normally.

### 🖱 Drag files in from Finder / Explorer
Drop a file or folder on a pane and its full path is typed at the prompt, exactly as a native
terminal does it — type `cd `, drop the folder, press Enter. Drop a file into a Claude Code
prompt and Claude can read it right away.

- **Several at once** — a multi-file drop lands as separate arguments
- **Quoted only when it has to be** — a plain path is typed plain; spaces and shell
  metacharacters get quoted (`'…'` on macOS, `"…"` on Windows) so nothing is ever executed
- The pane under the pointer lights up, so in a 4×4 grid you always know where the path is going
- Text and links dragged in from other apps are typed as text

> On Windows, drag-and-drop into an app **running as Administrator** is blocked by Windows
> itself (UIPI), not by Light Code — Explorer runs unelevated and Windows refuses to hand data
> across. Run Light Code normally and it works; paste (`Ctrl+V`) is the way in when it can't.

### 🚀 Fast and light
- Vanilla TypeScript renderer — no framework, instant tab switching
- GPU-accelerated terminal rendering (WebGL), scoped to the visible tab only
- Near-black frameless dark UI

### 🔄 Auto-update
The notification says what the update *contains* — the release notes travel with the update, so
you can see what changes before agreeing to it. "Later" defers for 30 minutes rather than
hiding it until the next launch, and if Claude is mid-turn in any pane, updating asks first and
says how many sessions it is about to end (on Windows the installer closes the app as soon as
the download lands).

The app quietly checks GitHub Releases shortly after each launch (never blocking startup).
When an update exists you get a small toast — update now with live download progress and an
automatic restart, or dismiss and be reminded next launch. The About dialog (version button in
the tab bar) shows the full changelog.

## Installation

Click the row that matches your machine — each link always serves the newest release:

| Your machine | Download |
| --- | --- |
| Windows 10 or 11 | **[LightCode-Setup.exe](https://github.com/digitalscapemy/lightcode/releases/latest/download/LightCode-Setup.exe)** |
| Mac — Apple Silicon (M1/M2/M3/M4, bought 2021 or later) | **[LightCode-arm64.dmg](https://github.com/digitalscapemy/lightcode/releases/latest/download/LightCode-arm64.dmg)** |
| Mac — Intel (bought 2019 or earlier) | **[LightCode-x64.dmg](https://github.com/digitalscapemy/lightcode/releases/latest/download/LightCode-x64.dmg)** |

Not sure which Mac you have? [Settle that first](#macos--first-which-dmg) — the wrong file won't
run.

Would rather browse? The [Releases page](https://github.com/digitalscapemy/lightcode/releases/latest)
lists every version with its notes. The `.zip`, `.blockmap` and `.yml` assets you'll see there
belong to the auto-updater, not to you.

Light Code is not code-signed: there is no Apple Developer or Windows publisher certificate
behind it. Both operating systems will therefore warn you the first time you open it. That is
expected, and the steps below walk you past it. You only ever do it once.

### macOS — first, which DMG?

There are two Mac builds because there are two kinds of Mac processor. Pick the wrong one and
the app may not start at all, so settle this before downloading anything.

Open the Apple menu  → **About This Mac**. One line in that window answers it:

#### Apple Silicon → [`LightCode-arm64.dmg`](https://github.com/digitalscapemy/lightcode/releases/latest/download/LightCode-arm64.dmg)

About This Mac shows **Chip: Apple M1**, or M2, M3, M4 — including the Pro, Max and Ultra
versions of each.

"Apple Silicon" means the processors Apple designs itself. They arrived in **November 2020**
with the M1 and have been in every new Mac since. **A Mac bought new in 2021 or later is Apple
Silicon** — no exceptions.

#### Intel → [`LightCode-x64.dmg`](https://github.com/digitalscapemy/lightcode/releases/latest/download/LightCode-x64.dmg)

About This Mac shows **Processor: Intel Core i5**, or i7, i9, or Xeon.

Apple used Intel processors from 2006 until the M1 replaced them. **A Mac bought new in 2019 or
earlier is Intel.** For this app the range that matters is roughly 2015–2020, since older Macs
can't run the required macOS version anyway (see below).

#### Bought your Mac in 2020?

That single year is the overlap — Apple sold Intel and M1 models side by side, sometimes the
same model name in both. Don't go by the year; open About This Mac and read the chip line. Same
advice for any second-hand Mac whose age you're unsure of.

#### Why it matters

The two mistakes are not equally bad:

| Mistake | What happens |
| --- | --- |
| arm64 build on an **Intel** Mac | **Won't launch at all.** Nothing you can do but download the other file. |
| x64 build on an **Apple Silicon** Mac | Runs, just slower — macOS translates it through Rosetta, and may ask to install Rosetta first. |

**One more thing to check in that same window: macOS 12 Monterey or newer is required.** That
means MacBook Air and MacBook Pro from Early 2015, iMac from Late 2015, Mac mini from Late 2014,
Mac Pro from Late 2013 — and anything newer. An older Mac can't run Light Code regardless of
which file you pick.

### macOS — installing

From here on the steps are identical on both Apple Silicon and Intel.

**Step 1 — Open the DMG.**
Double-click the file you downloaded. A window opens showing the Light Code icon next to a
shortcut to your Applications folder.

**Step 2 — Install it.**
Drag the **Light Code** icon onto the **Applications** folder. Then close that window and eject
the disk image — click ⏏ next to its name in the Finder sidebar.

**Step 3 — First launch.**
Do **not** double-click the app. Doing so gives you a dead-end dialog — *"Light Code cannot be
opened because the developer cannot be verified"* — whose only buttons are **Move to Bin** and
**Cancel**. If you're looking at it right now, press **Cancel**. Never press Move to Bin; that
deletes the app you just installed.

The way in is the right-click menu, which offers an **Open** button the double-click dialog
doesn't:

1. Open your **Applications** folder
2. **Right-click** (or Control-click) Light Code → **Open**
3. Confirm with **Open** in the dialog that appears

**If that still doesn't work**, recent macOS versions hide the override in Settings instead.
Right after being blocked, go to **System Settings → Privacy & Security**, scroll down to the
Security section, and click **Open Anyway** next to the message about Light Code. On macOS 12
and 13 the same button lives in **System Preferences → Security & Privacy → General**.

**Last resort**, and the one that always works — open **Terminal**, run this once, then launch
the app normally:

```sh
xattr -cr "/Applications/Light Code.app"
```

That command strips the "downloaded from the internet" quarantine flag macOS attached to the
file. Whichever route you take, it's a one-time thing: from then on Light Code opens like any
other app.

### Windows

**Step 1 — Download the installer.**
Grab **[`LightCode-Setup.exe`](https://github.com/digitalscapemy/lightcode/releases/latest/download/LightCode-Setup.exe)**.
Windows 10 and 11 are both supported, and there is only one file — unlike the Mac, there is no
architecture to choose here.

**Step 2 — Get past SmartScreen.**
Double-click the installer. Because it is unsigned, Windows shows a blue *"Windows protected
your PC"* screen. Click **More info**, then **Run anyway**. Your browser may flag the download
itself as well — choose **Keep** if it does.

**Step 3 — Let it run.**
There is nothing to configure: the installer completes on its own and opens Light Code when it
finishes, leaving a Start-menu entry and a desktop shortcut behind.

### After installing

Light Code works as a plain terminal with any CLI. The token-usage, session and account
features need [Claude Code](https://claude.com/claude-code) installed — set that up first if you
want them.

You won't have to repeat any of this for future versions: Light Code checks GitHub Releases
shortly after each launch and updates itself in place.

## Using it

Below, `Mod` means `⌘` on macOS and `Ctrl` on Windows — the same rule every shortcut
in the app follows, with one deliberate exception noted under *Moving between panes*.

### Tabs and panes are different things

A **tab** is a project: one folder, its own name, its own slot in the tab bar.
A **pane** is a terminal *inside* a tab. One tab holds up to 16 panes — that is what
"many Claude sessions side by side" means in practice.

### Pick a layout

Click the grid button (**⊞**) in the tab bar and choose an arrangement: 2 columns,
2×2, 3×2, 4×4, and more. Each thumbnail is drawn from the same description that builds
the real layout, so what you see is exactly what you get.

Switching layouts **keeps every running session alive** — panes are rearranged, never
restarted, so a Claude session mid-task survives the change. Choosing a *smaller*
layout closes the extra panes, which ends their shells, so it asks first.

To build a layout by hand instead: `Mod+Shift+E` splits the focused pane to the right,
`Mod+Shift+D` splits it downward, and the dividers drag.

### Moving between panes without the mouse

| | |
| --- | --- |
| `Ctrl+Tab` | next pane, wrapping at the end |
| `Ctrl+Shift+Tab` | previous pane |
| `Mod+Alt+←→↑↓` | the pane lying that way on screen |

`Ctrl+Tab` is the exception to the `Mod` rule: it is `Ctrl` on macOS too, because
`⌘+Tab` belongs to the operating system. Browsers and editors do the same.

Cycling follows reading order. The arrows follow the screen — in a 4×4 grid, reaching
the far corner takes two keystrokes instead of ten.

**Plain `Tab` and plain arrows are deliberately untouched**, so shell completion and
command history keep working. The same goes for `Alt+B` / `Alt+F` word motions and, on
Windows, `Ctrl+_` (undo in zsh and bash).

### Fitting more on screen

`Mod+=` and `Mod+-` resize the terminal text between 8 and 32px; `Mod+0` returns it to
14. It applies to every pane at once, new panes open at the size you chose, and the
setting survives a restart. This is what makes a 16-pane grid readable on a laptop.

### Opening several tabs at once

Right-click the **+** button to add 3, 8 or 16 tabs in one go rather than clicking it
repeatedly. Closing is unchanged — a tab's `×`, or `Mod+Shift+W` for the focused pane.

### Watching your sessions

Run `claude` in any pane and its header badge starts showing live token usage, read
from Claude Code's own session transcript rather than estimated. Hover for the full
breakdown; the headline number is context fill, because that is the one that runs out.

`Mod+Shift+M` opens **Mission Control** — every running Claude session in one list with
its status, model, context fill and idle time. Click a row to jump to that pane, or
tick several and send one command to all of them.

## Keyboard shortcuts

| Windows / Linux | macOS | Action |
| --- | --- | --- |
| `Ctrl+Shift+E` | `⌘+Shift+E` | Split pane right |
| `Ctrl+Shift+D` (or `S`) | `⌘+Shift+D` | Split pane down |
| `Ctrl+Shift+T` | `⌘+Shift+T` | New terminal tab |
| `Ctrl+Shift+W` | `⌘+Shift+W` | Close focused pane |
| `Ctrl+Shift+M` | `⌘+Shift+M` | Mission Control |
| `Ctrl+C` (or `Ctrl+Shift+C`) | `⌘+C` | Copy the selection — sends `^C` when nothing is selected |
| `Ctrl+V` | `⌘+V` | Paste text — or clipboard image as a file path |
| *(drag & drop)* | *(drag & drop)* | Drop a file or folder on a pane to type its path |
| `Ctrl+=` / `Ctrl+-` | `⌘+=` / `⌘+-` | Terminal text bigger / smaller (8–32px) |
| `Ctrl+0` | `⌘+0` | Reset text size to 14px |
| `Ctrl+Tab` | `Ctrl+Tab` | Focus next pane (wraps) |
| `Ctrl+Shift+Tab` | `Ctrl+Shift+Tab` | Focus previous pane |
| `Ctrl+Alt+←→↑↓` | `⌘+⌥+←→↑↓` | Focus the pane in that direction |

`Ctrl+Tab` is `Ctrl` on **both** platforms — `⌘+Tab` belongs to macOS itself, which is
why browsers and editors use `Ctrl+Tab` there too. Plain `Tab` and plain arrows are
deliberately left alone so shell completion and history keep working.

Copy only takes `Ctrl+C` when text is actually selected, and the selection is dropped
once copied — so the next `Ctrl+C` interrupts Claude as usual. Nothing selected, nothing
taken: the key goes straight through as `^C`. Use `Ctrl+Shift+C` if you would rather
never think about which one you are about to get.

## Build from source

### Prerequisites

| | Windows | macOS |
| --- | --- | --- |
| Node.js | **22.12 or newer** | **22.12 or newer** |
| Git | [git-scm.com](https://git-scm.com/download/win) | `xcode-select --install` (ships with it) |
| OS | Windows 10/11 | macOS 12 Monterey or newer |

Node 22.12 is a hard floor — `electron` and `electron-vite` both declare it. On Node 20
`npm install` still appears to succeed, but prints `EBADENGINE` warnings and the build
tooling can fail later in ways that do not point back here. Check with `node -v`.

`node-pty` ships prebuilt binaries for `win32-x64`, `win32-arm64`, `darwin-x64` and
`darwin-arm64`, so a compiler is normally **not** needed. If npm falls back to building
it from source you will also need Visual Studio Build Tools with the *Desktop
development with C++* workload on Windows, or Xcode Command Line Tools on macOS.

### Setup

Identical on both platforms:

```sh
git clone https://github.com/digitalscapemy/lightcode.git
cd lightcode
npm install
```

That is all — but if you are wondering why `package.json` carries a `postinstall`
that just runs `install-electron`, it is load-bearing:

> Electron 43 dropped the `postinstall` hook that used to fetch its binary — 30, 35
> and 40 all still had it — and now downloads lazily, on the first
> `require('electron')`.
>
> That is enough for `npm run dist`: its bytecode step requires Electron and triggers
> the download, which is why CI stayed green on a bare `npm ci`. But `electron-vite`
> resolves the binary path *itself* rather than going through `require`, and throws
> `Error: Electron uninstall` when it is missing — so `npm run dev` used to fail on a
> fresh clone while `npm run dist` succeeded, with `npm install` exiting **0** and
> nothing looking wrong.
>
> Our own `postinstall` restores what Electron removed. Do not delete it.

### Everyday commands

```sh
npm run dev        # dev mode with HMR
npm run typecheck  # TypeScript check
npm test           # unit tests (vitest)
npm run dist       # build an installer for the platform you are on
```

`npm run dist` builds only for the machine it runs on, and that is deliberate:
`npm run dist` compiles the main process to V8 bytecode, which is architecture-specific,
so a Mac cannot produce a working Windows or Intel build and vice versa. Cross-platform
installers come from CI, which runs one job per target — see
[`.github/workflows/build.yml`](.github/workflows/build.yml).

To build a specific macOS architecture on a Mac: `npm run dist -- --mac --arm64`
(or `--x64`). Do not pin both at once.

**Tech stack:** [Electron](https://electronjs.org) · [electron-vite](https://electron-vite.org) ·
[xterm.js](https://xtermjs.org) · [node-pty](https://github.com/microsoft/node-pty) ·
[electron-updater](https://www.electron.build/auto-update)

**Shell support:** PowerShell 7 / Windows PowerShell 5.1 on Windows; zsh / bash on macOS
(with automatic shell integration for cwd tracking — your rc files are sourced untouched).

### Project structure

```
src/shared    types + IPC contract (shared by all three layers)
src/main      main process: PTY manager, usage watcher, shortcuts, updater
src/preload   contextBridge boundary (window.lightclaude)
src/renderer  UI: tab bar, split tree, terminal panes, modals, toast
```

### Releases

Releases are built and published automatically by GitHub Actions: pushing a `vX.Y.Z` tag builds
Windows + macOS installers and publishes them (with `latest.yml` update feeds) to GitHub
Releases, which installed apps pick up automatically.

To cut one:

```sh
# 1. Describe the release to users first — src/shared/changelog.ts, newest entry
#    at the top, naming the version you are about to cut. One source, three
#    readers: the in-app About dialog, the GitHub release body, and the update
#    notification other people see (scripts/release-notes.cjs writes them into
#    build/release-notes.md at dist time, which electron-builder embeds in
#    latest.yml). No entry means no notes anywhere — CI warns, but still builds.
# 2. Bump + tag in one step, so the two can never disagree:
npm version patch -m "release v%s: what changed"   # patch | minor | major
git push && git push --tags
```

Use `npm version` rather than editing `package.json` by hand. A tag that disagrees with
`package.json` is the one release mistake nothing surfaces: electron-builder stamps the update
feed from `package.json`, so the feed advertises the *old* version, every installed app decides
it is already up to date, and the release is silently never delivered. CI now refuses to build
such a tag, and warns when the changelog has no entry for the version.

**What "auto-update" means per platform** — Windows downloads and installs the update in place,
with a progress bar and an automatic restart. macOS cannot: Squirrel.Mac refuses to install an
update that is not signed with the same Apple Developer ID as the app, and these builds are
unsigned. So macOS notifies, then opens the correct `.dmg` for that machine (Apple Silicon vs
Intel, Rosetta included) and the user drags it over. Paying for a Developer ID certificate and
notarising the build is the only thing that changes this.

## License

[MIT](LICENSE) © 2026 **Digital Scape MY**
