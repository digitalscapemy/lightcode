/**
 * Folders tabs were recently opened in, newest first, for the welcome page.
 * A convenience kept in this browser profile — losing it costs nothing, so
 * every read and write tolerates storage being unavailable.
 */
const KEY = 'lightcode.recentProjects'
const MAX = 6

export function recentProjects(): string[] {
  try {
    const raw = localStorage.getItem(KEY)
    const list = raw ? (JSON.parse(raw) as unknown) : []
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string' && x !== '') : []
  } catch {
    return []
  }
}

export function noteRecentProject(path: string): void {
  if (!path) return
  try {
    const key = (p: string): string => p.replace(/[\\/]+$/, '').toLowerCase()
    const next = [path, ...recentProjects().filter((p) => key(p) !== key(path))].slice(0, MAX)
    localStorage.setItem(KEY, JSON.stringify(next))
  } catch {
    // storage unavailable: no recents, nothing else changes
  }
}
