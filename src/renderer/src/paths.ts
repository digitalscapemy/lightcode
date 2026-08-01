/**
 * Turning an OS path into shell input, for the two routes that type one at a
 * live prompt: clipboard pastes and files dragged in from Finder/Explorer.
 * Quoted wrong, a path runs as a command — so the rule is the one every native
 * terminal follows: leave a plain path alone, quote the moment it isn't plain.
 */

/** Characters a POSIX shell reads literally (the set Python's shlex uses). */
const POSIX_PLAIN = /^[\w@%+=:,./-]+$/
/**
 * Windows is a shorter list on purpose: PowerShell gives `,` `@` `%` `$` `&`
 * meanings that cmd doesn't, and a path is never worth the argument.
 */
const WIN_PLAIN = /^[\w.:\\/-]+$/

/**
 * One path as one shell argument — returned bare when the shell would read it
 * literally anyway, quoted when it wouldn't, and null when it can't be made
 * safe at all.
 *
 * Control chars are rejected as defence in depth (main already filters them off
 * the clipboard) since a CR/LF would submit the command line. Windows: `"` is
 * illegal in a real path, so a path carrying one is spoofed → reject. POSIX:
 * single-quote and escape any embedded `'`.
 */
export function shellArg(p: string): string | null {
  if (/[\r\n\0]/.test(p)) return null
  if (window.lightclaude.platform === 'win32') {
    if (WIN_PLAIN.test(p)) return p
    return p.includes('"') ? null : `"${p}"`
  }
  if (POSIX_PLAIN.test(p)) return p
  return `'${p.replace(/'/g, "'\\''")}'`
}

/**
 * Several paths as separate arguments on one command line. Paths that can't be
 * made safe are dropped; '' when none survive.
 */
export function shellArgs(paths: string[]): string {
  return paths
    .map((p) => shellArg(p))
    .filter((p): p is string => p !== null)
    .join(' ')
}
