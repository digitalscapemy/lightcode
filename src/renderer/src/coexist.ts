/**
 * Two agents, one working tree — say so, and never do more than say so.
 *
 * Worktrees exist because several agents editing one checkout overwrite each
 * other. Nothing connected that to auto mode, though, and auto mode is exactly
 * when nobody is watching: four babysat panes in one folder will happily undo
 * each other's edits for an hour, and the first sign of it is a file that looks
 * nothing like what either agent thought it wrote.
 *
 * What this module does NOT do is prevent it. Working four panes in one folder
 * by hand is a legitimate way to work — often the right one, when the agents are
 * reading rather than writing, or when you are watching them. A tool that
 * refuses that has decided it knows the user's job better than they do. So this
 * is a sentence in a header, dismissible, and nothing else: no confirmation, no
 * refusal, no dialog between someone and the thing they asked for.
 *
 * Pure on purpose — no DOM, no IPC — so the rule can be tested directly.
 */

/** What the warning needs to know about one pane. */
export interface PaneGit {
  paneId: string
  /** The pane's git root, or null when it is not in a repository. */
  root: string | null
  /** The babysitter is armed on this pane. */
  auto: boolean
}

/**
 * Panes that share a working tree with another pane, at least one of which is
 * running unattended, mapped to what to tell them.
 *
 * The rule is deliberately narrow, because a warning that appears when it does
 * not have to is a warning nobody reads by the time it matters:
 *
 *  - Fewer than two panes in a root: nothing to collide with.
 *  - Nobody in the group is on auto: a human is driving, and two people editing
 *    one checkout is just a normal day.
 *  - Panes in different roots never warn about each other, which is precisely
 *    what makes a worktree the answer — moving one pane out clears it.
 *
 * Every pane in an offending group is told, not only the automated ones. The
 * pane about to be overwritten has as much reason to know as the pane doing it.
 */
export function sharedRootWarnings(panes: PaneGit[]): Map<string, string> {
  const byRoot = new Map<string, PaneGit[]>()
  for (const pane of panes) {
    if (pane.root === null) continue
    const group = byRoot.get(pane.root)
    if (group) group.push(pane)
    else byRoot.set(pane.root, [pane])
  }

  const warnings = new Map<string, string>()
  for (const group of byRoot.values()) {
    if (group.length < 2) continue
    const automated = group.filter((p) => p.auto).length
    if (automated === 0) continue
    const text = warningText(group.length, automated)
    for (const pane of group) warnings.set(pane.paneId, text)
  }
  return warnings
}

/**
 * The sentence itself, carrying the fix rather than only the fact.
 *
 * "2 agents share this folder" states a problem and leaves the reader to work
 * out what to do about it; the second half is the whole value of saying
 * anything. The menu path is named because that is where the answer lives and
 * it is not otherwise discoverable from a warning.
 */
function warningText(total: number, automated: number): string {
  const subject =
    automated === total
      ? `${total} auto-mode panes share this folder`
      : `${total} panes share this folder, ${automated} on auto`
  return `${subject}: they can overwrite each other. Give one its own worktree (⋮ → Open Worktree…).`
}

/**
 * Panes that have been told once and do not want telling again.
 *
 * Not persisted. A pane is a shell someone opened for a reason, and the reason
 * ends when the pane does; carrying a dismissal into a new pane would mean the
 * one time it mattered was the time it stayed quiet.
 */
const dismissed = new Set<string>()

export function dismissCoexist(paneId: string): void {
  dismissed.add(paneId)
}

export function isCoexistDismissed(paneId: string): boolean {
  return dismissed.has(paneId)
}

export function forgetCoexist(paneId: string): void {
  dismissed.delete(paneId)
}
