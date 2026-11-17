import { execFile, execFileSync } from 'child_process'
import { existsSync, statSync } from 'fs'
import { homedir } from 'os'
import { delimiter, join } from 'path'
import { TOOLS, type ToolStatus } from '../shared/tools'

/**
 * Which agent CLIs are installed, and keeping PATH current after an install.
 *
 * An installer adds its folder to the user's PATH in the registry, but a
 * running app keeps the PATH it started with — and passes that stale PATH to
 * every pane it opens. So a user installs Claude Code, opens a new pane, and is
 * told `claude` is not recognised. refreshProcessPath() reads PATH as Windows
 * has it now and merges it in, so new panes (and this check) see the install
 * without restarting Light Code. On macOS/Linux a login shell re-reads its own
 * profile, so only the known install folders are added.
 */

const PATH_KEY = process.platform === 'win32' ? (Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') ?? 'Path') : 'PATH'

/** %VAR% → its value, the way Windows expands REG_EXPAND_SZ entries. */
function expandWinVars(s: string): string {
  return s.replace(/%([^%]+)%/g, (m, name: string) => {
    const key = Object.keys(process.env).find((k) => k.toUpperCase() === name.toUpperCase())
    return key ? (process.env[key] ?? m) : m
  })
}

/** One PATH value from the registry, or '' when it cannot be read. */
function regPath(hive: string): string {
  try {
    const out = execFileSync('reg.exe', ['query', hive, '/v', 'Path'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore']
    })
    const m = /^\s*Path\s+REG(?:_EXPAND)?_SZ\s+(.*)$/im.exec(out)
    return m ? expandWinVars(m[1]!.trim()) : ''
  } catch {
    return ''
  }
}

/** Merge PATH lists, keeping order and dropping duplicates and blanks. */
export function mergePaths(lists: string[], sep = delimiter, win = process.platform === 'win32'): string {
  const seen = new Set<string>()
  const out: string[] = []
  for (const list of lists) {
    for (const raw of list.split(sep)) {
      const dir = raw.trim()
      if (!dir) continue
      const key = win ? dir.replace(/[\\/]+$/, '').toLowerCase() : dir.replace(/\/+$/, '')
      if (seen.has(key)) continue
      seen.add(key)
      out.push(dir)
    }
  }
  return out.join(sep)
}

function knownInstallDirs(): string[] {
  const home = homedir()
  const plat = process.platform === 'win32' ? 'win32' : 'posix'
  return TOOLS.flatMap((t) => t.installDirs[plat].map((d) => join(home, d)))
}

let lastRefresh = 0

/**
 * Bring this process's PATH up to date (throttled: at most every 10 s unless
 * forced). Existing entries keep their order; new ones are appended.
 */
export function refreshProcessPath(force = false): void {
  const now = Date.now()
  if (!force && now - lastRefresh < 10_000) return
  lastRefresh = now
  const current = process.env[PATH_KEY] ?? ''
  const fresh =
    process.platform === 'win32'
      ? [regPath('HKCU\\Environment'), regPath('HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment')]
      : []
  const existing = knownInstallDirs().filter((d) => {
    try {
      return statSync(d).isDirectory()
    } catch {
      return false
    }
  })
  process.env[PATH_KEY] = mergePaths([current, ...fresh, existing.join(delimiter)])
}

/** The full path of `bin` on PATH, or null. Windows tries PATHEXT and .ps1. */
export function whichIn(bin: string, path: string, platform = process.platform): string | null {
  const exts =
    platform === 'win32'
      ? ['', ...(process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean), '.PS1']
      : ['']
  for (const dir of path.split(platform === 'win32' ? ';' : ':')) {
    const d = dir.trim().replace(/^"|"$/g, '')
    if (!d) continue
    for (const ext of exts) {
      const file = join(d, bin + ext.toLowerCase())
      try {
        if (existsSync(file) && statSync(file).isFile()) return file
      } catch {
        // unreadable folder: skip it
      }
    }
  }
  return null
}

/** First line of `<file> --version`, or undefined. Never more than 5 s. */
function versionOf(file: string): Promise<string | undefined> {
  const lower = file.toLowerCase()
  if (lower.endsWith('.ps1')) return Promise.resolve(undefined) // would need a policy-dependent host
  const [cmd, args] =
    process.platform === 'win32' && (lower.endsWith('.cmd') || lower.endsWith('.bat'))
      ? ['cmd.exe', ['/d', '/c', file, '--version']]
      : [file, ['--version']]
  return new Promise((resolve) => {
    execFile(cmd, args as string[], { timeout: 5000, windowsHide: true, encoding: 'utf8' }, (_err, stdout) => {
      const line = String(stdout ?? '')
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find(Boolean)
      resolve(line ? line.slice(0, 80) : undefined)
    })
  })
}

/** Installed or not, where, and which version — for every known tool. */
export async function checkTools(): Promise<ToolStatus[]> {
  refreshProcessPath(true)
  const path = process.env[PATH_KEY] ?? ''
  return Promise.all(
    TOOLS.map(async (t): Promise<ToolStatus> => {
      const file = whichIn(t.bin, path)
      if (!file) return { id: t.id, installed: false }
      return { id: t.id, installed: true, path: file, version: await versionOf(file) }
    })
  )
}
