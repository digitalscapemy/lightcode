export interface ChangelogEntry {
  version: string
  date: string
  notes: string[]
}

export const DEVELOPER = 'Digital Scape MY'

/** Newest first. Add an entry on every release (see release procedure). */
export const CHANGELOG: ChangelogEntry[] = [
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
