import { existsSync, statSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { AGENTS } from '../shared/agents'

/**
 * Which agents can be started here: is each adapter's command on PATH?
 *
 * For the pickers only, which dim an agent that is not found rather than hide
 * it — a PATH the app was started with is not always the PATH a pane's login
 * shell ends up with, so "not found" is said, never enforced.
 */

/** Places a command-line agent commonly lands that a GUI app's PATH may lack. */
function extraDirs(platform: NodeJS.Platform, home: string): string[] {
  if (platform === 'win32') return []
  return ['/opt/homebrew/bin', '/usr/local/bin', join(home, '.local', 'bin'), join(home, '.npm-global', 'bin')]
}

/**
 * Whether `bin` is a file in one of the PATH folders. On Windows a command is
 * found by any PATHEXT extension, plus `.ps1`, which is how npm installs one
 * for PowerShell. Pure apart from `exists`.
 */
export function onPath(
  bin: string,
  o: { path: string; pathext?: string; platform: NodeJS.Platform; extra?: string[]; exists: (file: string) => boolean }
): boolean {
  if (bin === '') return true
  const sep = o.platform === 'win32' ? ';' : ':'
  const dirs = [...o.path.split(sep), ...(o.extra ?? [])].filter((d) => d.trim() !== '')
  const exts =
    o.platform === 'win32'
      ? ['', ...(o.pathext ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean), '.PS1'].map((e) => e.toLowerCase())
      : ['']
  for (const dir of dirs) {
    for (const ext of exts) {
      if (o.exists(join(dir.replace(/^"|"$/g, ''), bin + ext))) return true
    }
  }
  return false
}

let cached: Record<string, boolean> | null = null

/** Every adapter id, found or not. Worked out once per run: PATH does not move. */
export function agentAvailability(): Record<string, boolean> {
  if (cached !== null) return cached
  const env = process.env
  const path = env.PATH ?? env.Path ?? ''
  const isFile = (file: string): boolean => {
    try {
      return existsSync(file) && statSync(file).isFile()
    } catch {
      return false
    }
  }
  const out: Record<string, boolean> = {}
  for (const [id, adapter] of Object.entries(AGENTS)) {
    out[id] = onPath(adapter.bin, {
      path,
      pathext: env.PATHEXT,
      platform: process.platform,
      extra: extraDirs(process.platform, homedir()),
      exists: isFile
    })
  }
  cached = out
  return out
}
