/** The role a pane holds, as remembered across restarts. */
export interface PaneNodeRole {
  id: string
  /** Folder this squad shares; where reports are written and read. */
  squadDir: string
}

export type Orientation = 'row' | 'column'

export interface PaneNode {
  type: 'pane'
  id: string
  /** User-set title; overrides shell titles and survives restarts. */
  name?: string
  /** Last live cwd (from shell integration); respawn opens here. */
  cwd?: string
  /**
   * Squad role this pane holds, and where its squad keeps its reports.
   *
   * On the layout node rather than only in memory so a role survives a restart.
   * A pane that came back as a plain terminal while still sitting in its role's
   * worktree would be the worst of both: the branch says it is the developer,
   * the agent has never been told, and nothing on screen disagrees.
   */
  role?: PaneNodeRole
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
  /** Terminal font size in px, shared by every pane. Absent on pre-0.3 state. */
  fontSize?: number
  /** Git tree panel docked open. Absent on pre-0.5 state, which means closed. */
  gitPanelOpen?: boolean
  /**
   * The git panel fetches from the remote every few minutes while it is open.
   * Absent means on: it only ever reads the remote, and a panel that says
   * "in sync" about a remote it last saw yesterday is worse than one that asks.
   */
  gitAutoFetch?: boolean
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
