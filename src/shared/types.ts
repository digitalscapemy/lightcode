/** The role a pane holds, as remembered across restarts. */
export interface PaneNodeRole {
  id: string
  /** Folder this squad shares; where reports are written and read. */
  squadDir: string
}

/**
 * Which agent a pane runs, by adapter id ('claude', 'codex', 'gemini', 'shell').
 * A string rather than a union so a state file written by a later version
 * still loads; an id nobody knows is treated as no agent named at all.
 */
export type AgentKind = string

/**
 * The crew a pane belongs to: an orchestra lead and the workers it drives.
 *
 * Linked by a crew id and a handle, never by pane id. Pane ids are minted
 * afresh on every restart (see regenPaneIds), so a link stored as one would
 * point at nothing the next morning; an id and a handle on each member's own
 * node come back with the node and need no remapping at all.
 */
export interface PaneNodeCrew {
  /** Stable across restarts. Every member of one crew carries the same id. */
  id: string
  /** How the crew addresses this pane: `lc send @developer …`. Unique per crew. */
  handle: string
  /** The pane conducting. One per crew; normaliseCrews settles any dispute. */
  lead?: true
  /** The lead's worker strip is folded to one line. */
  stripCollapsed?: true
}

/** What the person has allowed a crew, set from the Orchestra panel. */
export interface CrewSettings {
  /** The lead may answer its workers' permission prompts with `lc approve`. */
  leadMayApprove?: boolean
  /** Driving outside the crew is refused rather than warned about. */
  strict?: boolean
  /** The lead's commands to its workers are held. */
  paused?: boolean
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
  /** The orchestra this pane conducts or plays in. Absent: an ordinary pane. */
  crew?: PaneNodeCrew
  /** The agent this pane was opened for. Absent: whatever the user types. */
  agent?: AgentKind
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
  /** Orchestra panel docked open. Absent means closed. */
  orchPanelOpen?: boolean
  /**
   * Per-crew permissions, keyed by crew id. Absent, or absent for a crew, means
   * every setting off — the defaults are the cautious ones.
   */
  crewSettings?: Record<string, CrewSettings>
}

/** `function <name> { Set-Location -LiteralPath '<path>' }` */
export interface PathShortcut {
  name: string
  path: string
  /** Grouping label; also the sub-folder under `projectRoot` for new projects. */
  category?: string
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
  /** Main projects folder. Optional: without it every path is typed by hand. */
  projectRoot?: string
  /** Project categories, each a sub-folder of `projectRoot`. */
  categories?: string[]
}

export interface ShortcutsSaveResult {
  ok: boolean
  profilesWritten: string[]
  errors: string[]
  /** Folders that did not exist and were created on save. */
  created?: string[]
  /** Non-blocking problems (a folder that could not be created, …). */
  warnings?: string[]
}

export interface ShortcutsImportResult {
  paths: PathShortcut[]
  accounts: AccountShortcut[]
  /** Entries recognised but not importable (unresolvable variables etc.). */
  skipped: number
  /** Profile files that exist on this machine (0 on a fresh install). */
  found?: number
  /** Profile files that exist but could not be read, with the reason. */
  unreadable?: string[]
}
