import type { PendingWork } from './ipc'

/**
 * Branch-name rules, shared by both ends on purpose.
 *
 * The renderer needs them to refuse a name while it is being typed; main needs
 * them so nothing reaches `git` unchecked even if a caller skips the dialog. One
 * copy, so the two can never disagree about what is allowed.
 *
 * Deliberately importing nothing at runtime: the renderer is sandboxed with no
 * node integration, so anything shared with it has to be plain string work. Path
 * building for worktrees therefore lives in main/git.ts, where `path` exists.
 */

/** Control characters, written as escapes so this file stays plain ASCII. */
const CONTROL = /[\u0000-\u001f\u007f]/

/**
 * Why a branch name would be rejected, or null when it is fine.
 *
 * Git's own rules (git-check-ref-format) are wider than this, and permit names a
 * person would never mean: `-x` reads as a flag, `a..b` as a range. Saying so
 * before the name is used gives a sentence about the name, where git would later
 * give a `fatal:` about a ref — not the same thing to someone who has just typed
 * it.
 */
export function branchNameError(name: string): string | null {
  if (name.trim() === '') return 'Give the branch a name.'
  if (name !== name.trim()) return 'Branch names cannot start or end with a space.'
  if (/\s/.test(name)) return 'Branch names cannot contain spaces — try dashes.'
  if (/[~^:?*[\\]/.test(name)) return 'Branch names cannot contain ~ ^ : ? * [ or \\'
  if (CONTROL.test(name)) return 'Branch names cannot contain control characters.'
  if (name.startsWith('-')) return 'Branch names cannot start with a dash.'
  if (name.startsWith('.') || name.endsWith('.')) {
    return 'Branch names cannot start or end with a dot.'
  }
  if (name.includes('..')) return 'Branch names cannot contain two dots in a row.'
  if (name.includes('@{')) return 'Branch names cannot contain @{'
  if (name.endsWith('.lock')) return 'Branch names cannot end with .lock'
  if (name.startsWith('/') || name.endsWith('/') || name.includes('//')) {
    return 'Branch names cannot start, end, or double up on /'
  }
  return null
}

/** Enough names to recognise the work; past that the list stops being read. */
const NAMES_SHOWN = 4

function names(paths: string[]): string {
  const shown = paths.slice(0, NAMES_SHOWN)
  const rest = paths.length - shown.length
  return rest > 0 ? `${shown.join(', ')} and ${rest} more` : shown.join(', ')
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`
}

/**
 * What removing a worktree would destroy, as a sentence, or null when it would
 * destroy nothing.
 *
 * Lives here rather than in the pane because main is what reads the worktree and
 * the renderer is what asks the question, and the two must not describe the same
 * files differently.
 *
 * The wording is the fix for a real way of losing work. An agent writes a new
 * file and never runs `git add`; the header shows no dirty dot and a tooltip
 * saying "clean", because an untracked build directory must not light that
 * marker for ever. The user decides that agent's answer is the one to throw
 * away, and the removal dialog then said only "uncommitted changes" — which
 * reads, against a header saying clean, as the app being over-careful. So this
 * names the files instead of summarising them, and never offers "the branch is
 * kept" as comfort for a file that was never on the branch.
 */
export function pendingWorkWarning(pending: PendingWork): string | null {
  const { modified, untracked } = pending
  if (modified.length + untracked.length === 0) return null

  const parts: string[] = []
  if (modified.length > 0) {
    parts.push(`${plural(modified.length, 'modified file')} (${names(modified)})`)
  }
  if (untracked.length > 0) {
    parts.push(`${plural(untracked.length, 'untracked file')} (${names(untracked)})`)
  }
  const head =
    `This worktree holds ${parts.join(' and ')}. ` +
    'Removing it deletes the folder and everything in it.'

  // The branch is real comfort for a tracked edit: the committed version of that
  // file is still on it. For an untracked file it is no comfort whatsoever, and
  // offering it unqualified is how the old wording came to read as fussiness. So
  // the reassurance never appears without the exception beside it.
  if (untracked.length === 0) {
    return `${head} The branch keeps every commit; these edits are not in one.`
  }
  const one = untracked.length === 1
  const them = one ? 'it' : 'them'
  if (modified.length === 0) {
    return (
      `${head} ${one ? 'That file was' : 'Those files were'} never committed, so the branch ` +
      `has no copy of ${them} and nothing brings ${them} back.`
    )
  }
  return (
    `${head} The branch keeps every commit, but the untracked ${one ? 'file was' : 'files were'} ` +
    `never committed to anything — nothing brings ${them} back.`
  )
}
