/**
 * Branch-name rules, shared by both ends on purpose.
 *
 * The renderer needs them to refuse a name while it is being typed; main needs
 * them so nothing reaches `git` unchecked even if a caller skips the dialog. One
 * copy, so the two can never disagree about what is allowed.
 *
 * Deliberately importing nothing: the renderer is sandboxed with no node
 * integration, so anything shared with it has to be plain string work. Path
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
