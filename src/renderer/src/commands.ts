import type { IconName } from './ui/icons'
import type { ShortcutAction } from './keys'

/**
 * Everything the user can do, in one list.
 *
 * The command palette searches it, the cheat-sheet prints the ones with a
 * shortcut, and both read the shortcut text from keys.ts — so a feature is
 * reachable by name even when its button is hidden or its gesture forgotten,
 * and no list of shortcuts can drift from the keys that actually work.
 */

export type CommandGroup =
  | 'General'
  | 'Tabs & panes'
  | 'Navigate'
  | 'Agents'
  | 'Panels'
  | 'Layout'
  | 'View'

export interface Command {
  /** Stable id, also used to remember recent commands. */
  id: string
  title: string
  group: CommandGroup
  /** Extra words people might type for it. */
  keywords?: string
  /** Its keyboard shortcut, if it has one. */
  shortcut?: ShortcutAction
  icon?: IconName
  /** Hidden from the palette while this returns false. */
  when?: () => boolean
  run: () => void
}

let registry: Command[] = []

export function registerCommands(commands: Command[]): void {
  const ids = new Set<string>()
  for (const c of commands) {
    if (ids.has(c.id)) throw new Error(`duplicate command id: ${c.id}`)
    ids.add(c.id)
  }
  registry = commands
}

export function allCommands(): Command[] {
  return registry
}

export function availableCommands(): Command[] {
  return registry.filter((c) => {
    try {
      return c.when ? c.when() : true
    } catch {
      return false
    }
  })
}

/** Groups in the order the cheat-sheet and an empty palette show them. */
export const GROUP_ORDER: CommandGroup[] = [
  'General',
  'Tabs & panes',
  'Navigate',
  'Agents',
  'Panels',
  'Layout',
  'View'
]
