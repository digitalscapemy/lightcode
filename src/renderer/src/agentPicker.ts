import { AGENTS, AGENT_IDS } from '../../shared/agents'

/**
 * The agent pickers' rows: the squad dialog's per-role select, "Add Worker…"
 * and "Agent ▸".
 *
 * An agent whose command main could not find on PATH is dimmed and says so,
 * and can still be picked: the PATH the app started with is not always the
 * one a pane's login shell ends up with, and a picker that refuses what the
 * shell would have found is the feature getting in the way. An adapter written
 * from documentation alone says that too.
 */

export interface AgentOption {
  id: string
  /** What the row reads: the agent's name, with its caveat when it has one. */
  label: string
  /** Why it is dimmed, or null when it is not. */
  note: string | null
}

/** Every agent, in the table's order. Pure. */
export function agentOptions(available: Record<string, boolean>): AgentOption[] {
  return AGENT_IDS.map((id) => {
    const a = AGENTS[id]!
    const missing = a.bin !== '' && available[id] === false
    const notes = [
      ...(missing ? [`\`${a.bin}\` was not found on PATH`] : []),
      ...(a.untested ? ['not yet tried with Light Code'] : [])
    ]
    return {
      id,
      label: a.label + (missing ? ' (not found)' : a.untested ? ' (untested)' : ''),
      note: notes.length > 0 ? notes.join('; ') : null
    }
  })
}
