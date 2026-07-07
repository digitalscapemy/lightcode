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
- Rename tabs (double-click) and panes (⋮ menu) — names survive restarts
- **Working-directory memory**: shell integration tracks every `cd` live, and each pane reopens
  in its last folder after a restart. New splits open in the source pane's current folder.

### 📸 Paste screenshots into Claude
Snip something (`Win+Shift+S` / `Cmd+Shift+4`), press `Ctrl/Cmd+V` in the terminal — the image
is saved to a temp file and its path is pasted, ready for Claude Code to read. Plain text pastes
normally.

### 🚀 Fast and light
- Vanilla TypeScript renderer — no framework, instant tab switching
- GPU-accelerated terminal rendering (WebGL), scoped to the visible tab only
- Near-black frameless dark UI

### 🔄 Auto-update
The app quietly checks GitHub Releases shortly after each launch (never blocking startup).
When an update exists you get a small toast — update now with live download progress and an
automatic restart, or dismiss and be reminded next launch. The About dialog (version button in
the tab bar) shows the full changelog.

## Installation

Grab the latest installer from **[Releases](https://github.com/digitalscapemy/lightcode/releases/latest)**:

| Platform | File | Notes |
| --- | --- | --- |
| Windows 10/11 | `LightCode-Setup-x.y.z.exe` | One-click install; auto-updates itself |
| macOS | `LightCode-x.y.z-arm64.dmg` | Unsigned build — right-click → Open the first time, or run `xattr -cr "/Applications/Light Code.app"` |

Requires [Claude Code](https://claude.com/claude-code) for the token-usage features
(the terminal works with any CLI).

## Keyboard shortcuts

| Windows / Linux | macOS | Action |
| --- | --- | --- |
| `Ctrl+Shift+E` | `⌘+Shift+E` | Split pane right |
| `Ctrl+Shift+D` (or `S`) | `⌘+Shift+D` | Split pane down |
| `Ctrl+Shift+T` | `⌘+Shift+T` | New terminal tab |
| `Ctrl+Shift+W` | `⌘+Shift+W` | Close focused pane |
| `Ctrl+V` | `⌘+V` | Paste text — or clipboard image as a file path |

## Build from source

```sh
git clone https://github.com/digitalscapemy/lightcode.git
cd lightcode
npm install        # node-pty ships prebuilds — usually no compiler needed
npm run dev        # dev mode with HMR
npm run typecheck  # TypeScript check
npm run dist       # build a platform installer with electron-builder
```

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

## License

[MIT](LICENSE) © 2026 **Digital Scape MY**
