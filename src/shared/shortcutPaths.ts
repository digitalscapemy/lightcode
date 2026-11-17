/**
 * Path building for the shortcuts modal. Pure, so the renderer (no `path`
 * module) and main agree on exactly the same folder for a project or account.
 */

/** Join path parts with `sep`, dropping stray separators at the seams. */
export function joinPath(sep: string, ...parts: string[]): string {
  const cleaned = parts
    .map((p, i) => {
      let s = p.trim()
      if (i > 0) s = s.replace(/^[\\/]+/, '')
      // Keep a bare drive/root ("C:\", "/") intact; trim the rest.
      if (!/^([A-Za-z]:)?[\\/]$/.test(s)) s = s.replace(/[\\/]+$/, '')
      return s
    })
    .filter(Boolean)
  return cleaned.reduce((acc, part) => (/[\\/]$/.test(acc) ? acc + part : `${acc}${sep}${part}`))
}

/** `<root>\<category>\<name>`, or `<root>\<name>` without a category. */
export function projectTarget(root: string, category: string | undefined, name: string, sep: string): string {
  return category ? joinPath(sep, root, category, name) : joinPath(sep, root, name)
}

/** `<home>\.claude-<name>` — one Claude config dir per account. */
export function accountTarget(home: string, name: string, sep: string): string {
  return joinPath(sep, home, `.claude-${name}`)
}

/** A category becomes a folder name, so it must be one on every OS. */
export function isValidCategory(category: string): boolean {
  const c = category.trim()
  if (!c || c === '.' || c === '..' || c !== category) return false
  if (/[\\/:*?"<>|\x00-\x1f]/.test(c)) return false
  if (/[. ]$/.test(c)) return false // Windows strips these silently
  return !/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(c)
}

/** True when `child` sits inside `root` (case-insensitive on Windows). */
export function isInside(root: string, child: string, caseInsensitive: boolean): boolean {
  const norm = (p: string): string => {
    const s = p.replace(/[\\/]+/g, '/').replace(/\/$/, '')
    return caseInsensitive ? s.toLowerCase() : s
  }
  const r = norm(root)
  const c = norm(child)
  return r.length > 0 && c.startsWith(r + '/') && !c.split('/').includes('..')
}
