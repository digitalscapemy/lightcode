export interface ChangelogEntry {
  version: string
  date: string
  notes: string[]
}

export const DEVELOPER = 'Digital Scape MY'

/** Newest first. Add an entry on every release (see release procedure). */
export const CHANGELOG: ChangelogEntry[] = [
  {
    version: '0.4.2',
    date: '2026-08-03',
    notes: [
      'Copying out of a terminal works. Select some text, press Ctrl+C, paste it anywhere else and nothing arrived — what came back was whatever had been on the clipboard beforehand. A terminal draws its own selection rather than handing it to the system, so the copy had nowhere to go, and neither platform said a word about it. On Windows it was worse than useless: the same key still interrupted whatever Claude was doing. Ctrl+C now copies when text is selected and interrupts when none is, and the selection clears the moment it is copied, so the next press interrupts exactly as it always did. Ctrl+Shift+C copies either way, for anyone who would rather not think about which one they are about to get.',
      'Light Code keeps looking for updates while it runs — every few hours, rather than once at startup and never again. A window left open for days would otherwise never hear about a release published after it opened, and the only way to find out was to quit the app, which nobody does in the hope of being told there is an update.',
      'And when one arrives while you are working somewhere else, your desktop now says so, once per version rather than at every check. Clicking the notification brings Light Code forward with the details already waiting; if the window is in front of you the notification stays quiet, because the message is already on screen. Windows gets more than that back: notifications from this app were being dropped by Windows without a word, so the alert for Claude finishing a turn or waiting on a permission has been going nowhere either. Both arrive now.'
    ]
  },
  {
    version: '0.4.1',
    date: '2026-08-01',
    notes: [
      'The update notification now tells you what the update actually contains, instead of a version number and nothing else. Until now it could not: an app only carries the release notes of its own version, written before the newer one existed, so the notes travel with the update itself from here on.',
      'It also stops being so easy to ignore. "Later" now means half an hour rather than forever — the old button hid the notification until the next launch, which on a window left open for days meant never. The app itself is untouched while it waits; nothing is blocked and nothing installs behind your back.',
      'Updating while Claude is mid-turn now asks first, and says how many panes it is about to end. On Windows the installer closes the app the moment the download finishes, so a click meant to be harmless could take a long autonomous run down with it.'
    ]
  },
  {
    version: '0.4.0',
    date: '2026-08-01',
    notes: [
      'Drag a file or folder out of Finder or Explorer and drop it on a pane — its full path is typed at the prompt, the way every native terminal has always worked. Type `cd `, drop the folder, press Enter; or drop a file into a Claude Code prompt and Claude can read it straight away. Drop several at once and they arrive as separate arguments, the pane under the pointer lights up so there is never any doubt about where the path is going, and a path is only quoted when the shell actually needs it — a plain path stays plain, exactly as you would have typed it. Dropping a file anywhere else in the window now does nothing at all, instead of the browser default of navigating the app away and taking every running session with it.',
      'Updating on macOS goes straight to the installer your Mac can actually run, instead of a release page listing two near-identical downloads to choose between. Apple Silicon and Intel are told apart automatically, and a Mac running the Intel build under Rosetta is offered the native Apple Silicon one.'
    ]
  },
  {
    version: '0.3.1',
    date: '2026-08-01',
    notes: [
      'Nothing has changed inside the app. This release exists to rename the installer files: the Mac downloads are now LightCode-arm64.dmg and LightCode-x64.dmg, and the Windows one is LightCode-Setup.exe, none of them carrying a version number any more. A download link can therefore keep pointing at the newest build instead of breaking every time a version ships. Updating is unaffected — the app still picks the right build for your Mac on its own.',
      'The installation instructions were rewritten for people who do not write software: how to tell an Apple Silicon Mac from an Intel one and why picking wrong matters, and how to get past the macOS and Windows warnings that appear because these builds carry no developer signature.'
    ]
  },
  {
    version: '0.3.0',
    date: '2026-08-01',
    notes: [
      'Layout picker: a new grid button in the tab bar opens a visual menu of pane arrangements — 2 columns, 2×2, 3×2, 4×4 and more, up to 16 panes. Pick a shape instead of splitting one pane at a time. Switching layouts rearranges the panes you already have rather than restarting them, so every running Claude session survives the change; picking a smaller layout closes the extra panes and asks first.',
      'Open several tabs at once: right-click the "+" button to add 3, 8 or 16 tabs in one go instead of clicking it repeatedly.',
      'Adjustable terminal text size with Ctrl/Cmd +, - and 0 — useful once a layout gets dense enough that the default 14px stops fitting. It applies to every pane, new panes open at the size you picked, and the choice survives a restart.',
      'Keyboard navigation between panes, so a dense layout no longer needs the mouse. Ctrl+Tab and Ctrl+Shift+Tab cycle through the panes in the current tab, and Ctrl/Cmd+Alt with the arrow keys jumps to the pane lying that way on screen — in a 4×4 grid that is two keystrokes instead of ten. Ctrl+Tab is Ctrl on both Windows and macOS. Plain Tab and plain arrows are untouched, so shell completion and command history keep working exactly as before.',
      'App shortcuts no longer fire while you are typing in a tab or pane rename box, which used to trigger the shortcut and then silently commit the half-typed name.',
      'Fixed on macOS: several tooltips named Ctrl when the actual shortcut is Cmd. Fixed on Windows: Ctrl+Shift+minus is Ctrl+underscore, which is undo in zsh and bash — the font-size shortcut was swallowing it, and now leaves it to the shell.',
      'macOS installers are back, for both Apple Silicon and Intel Macs. Releases had been Windows-only since 0.1.2, and the last macOS build before that was Apple Silicon only. macOS 12 Monterey or newer is required.'
    ]
  },
  {
    version: '0.2.1',
    date: '2026-07-17',
    notes: [
      'Fixed tabs getting stuck or disappearing when dragged — most often when flicking a tab from the far right while the machine was under load. A drag that lost its pointer left the tab stranded off-screen for good; drags now always clean up after themselves, and reordering no longer thrashes the layout.',
      'The status indicator now follows the conversation instead of guessing from silence. It stays green for as long as Claude is actually working — including long builds and test runs — and turns amber the moment a turn ends, in a fraction of a second rather than several.',
      'Removed the red "needs approval" indicator: a permission prompt and a slow tool look identical in the session transcript, so it was frequently wrong. It will return when there is a signal worth trusting.',
      'The status dot and token badge now clear when a session ends, instead of staying lit forever.',
      'The token badge now shows context fill — the number that actually runs out. The old headline was mostly cache reads re-counted every turn, which climbed into the millions and measured nothing; the full breakdown moved to the tooltip.',
      'Token counts keep up in real time. A timestamp-precision bug was hiding most updates until something else happened to trigger a re-read.'
    ]
  },
  {
    version: '0.2.0',
    date: '2026-07-08',
    notes: [
      'Mission Control (Ctrl+Shift+M): one panel showing every running Claude session — live status (working / waiting for you / needs approval), model, context fill, tokens, last tool and idle time. Click a row to jump straight to that pane.',
      'Per-pane and per-tab status indicators, plus desktop notifications when Claude finishes a turn or gets blocked on a permission prompt.',
      'Broadcast input: tick target panes in Mission Control and send one command to all of them at once.',
      'Auto-continue babysitter: opt in per pane to keep long autonomous runs going — it nudges Claude when a turn ends, never auto-approves permission prompts, and stands down after a few nudges.'
    ]
  },
  {
    version: '0.1.2',
    date: '2026-07-07',
    notes: [
      'About dialog now shows only the current release notes, with a cleaner minimalist scrollbar.',
      'Faster releases: automated builds are Windows-only for now.',
      'Auto-update verification release.'
    ]
  },
  {
    version: '0.1.1',
    date: '2026-07-07',
    notes: [
      'Renamed the app to Light Code.',
      'Auto-update pipeline reliability fixes: releases are published via GitHub CLI and installer artifacts use space-free names so update downloads always resolve.',
      'First self-updating release — from here on the app updates itself.'
    ]
  },
  {
    version: '0.1.0',
    date: '2026-07-07',
    notes: [
      'Initial release.',
      'Multi-tab terminal manager with split panes (right/down), drag-reorder tabs, resizable gutters and pane maximize.',
      'Real-time Claude Code token usage badge per pane — session tokens plus context-window fill, attributed to the pane that launched the session.',
      'Multi-account Claude support: usage tracking follows every configured CLAUDE_CONFIG_DIR.',
      'Shortcuts Manager: project and account shortcuts managed in-app and written to your shell profile (PowerShell / zsh / bash), with auto-import of existing entries.',
      'Live working-directory tracking via shell integration; panes reopen in their last folder after restart.',
      'Paste screenshots directly into the terminal (Ctrl/Cmd+V) — images are saved to a temp file and pasted as a path Claude Code can read.',
      'Rename tabs (double-click) and panes (⋮ menu); names persist across restarts.',
      'GPU-accelerated rendering (WebGL) and automatic update checks.'
    ]
  }
]
