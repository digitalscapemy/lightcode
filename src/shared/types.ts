export type Orientation = 'row' | 'column'

export interface PaneNode {
  type: 'pane'
  id: string
  /** User-set title; overrides shell titles and survives restarts. */
  name?: string
  /** Last live cwd (from shell integration); respawn opens here. */
  cwd?: string
}

export interface SplitNode {
  type: 'split'
  orientation: Orientation
  children: LayoutNode[]
  /** Fractions summing to 1, one per child. */
  sizes: number[]
}

export type LayoutNode = PaneNode | SplitNode

export interface TabState {
  id: string
  name: string
  projectPath: string
  layout: LayoutNode
}

export interface WindowState {
  width: number
  height: number
  x?: number
  y?: number
  maximized: boolean
}

export interface PersistedState {
  version: 1
  window?: WindowState
  activeTabId: string | null
  tabs: TabState[]
}

/** `function <name> { Set-Location -LiteralPath '<path>' }` */
export interface PathShortcut {
  name: string
  path: string
}

/** `function <name> { $env:CLAUDE_CONFIG_DIR = '<dir>'; & claude.exe @args }` */
export interface AccountShortcut {
  name: string
  configDir: string
}

export interface ShortcutsConfig {
  version: 1
  paths: PathShortcut[]
  accounts: AccountShortcut[]
}

export interface ShortcutsSaveResult {
  ok: boolean
  profilesWritten: string[]
  errors: string[]
}

export interface ShortcutsImportResult {
  paths: PathShortcut[]
  accounts: AccountShortcut[]
  /** Entries recognised but not importable (unresolvable variables etc.). */
  skipped: number
}
