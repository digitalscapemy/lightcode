import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'
import type {
  ShortcutsConfig,
  ShortcutsImportResult,
  ShortcutsSaveResult
} from '../shared/types'

const START_MARKER = '# >>> LightClaude shortcuts >>>'
const END_MARKER = '# <<< LightClaude shortcuts <<<'
const IS_WIN = process.platform === 'win32'
const EOL = IS_WIN ? '\r\n' : '\n'

function emptyConfig(): ShortcutsConfig {
  return { version: 1, paths: [], accounts: [] }
}

// ---------- JSON store (mirrors stateStore's atomic pattern) ----------

function shortcutsFile(): string {
  return join(app.getPath('userData'), 'shortcuts.json')
}

export function loadShortcuts(): ShortcutsConfig {
  try {
    const raw = readFileSync(shortcutsFile(), 'utf8')
    const parsed = JSON.parse(raw) as ShortcutsConfig
    if (parsed && parsed.version === 1) {
      return {
        version: 1,
        paths: Array.isArray(parsed.paths) ? parsed.paths : [],
        accounts: Array.isArray(parsed.accounts) ? parsed.accounts : []
      }
    }
  } catch {
    // missing or corrupt — start fresh
  }
  return emptyConfig()
}

function saveShortcutsJson(cfg: ShortcutsConfig): void {
  const file = shortcutsFile()
  const tmp = file + '.tmp'
  writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf8')
  renameSync(tmp, file)
}

// ---------- Profile targets ----------

/**
 * Windows: CurrentUserCurrentHost for both PowerShell editions. Deliberately
 * NOT the AllHosts profile.ps1 — that loads BEFORE the CurrentHost file, so
 * the user's pre-existing duplicate functions would shadow ours. A block at
 * the END of the CurrentHost file wins in every load order.
 * app.getPath('documents') uses SHGetKnownFolderPath — OneDrive-redirect safe.
 *
 * macOS/Linux: ~/.zshrc and ~/.bashrc (whichever shell the user runs, the
 * managed block is present).
 */
export function profileTargets(): string[] {
  if (IS_WIN) {
    const docs = app.getPath('documents')
    return [
      join(docs, 'WindowsPowerShell', 'Microsoft.PowerShell_profile.ps1'),
      join(docs, 'PowerShell', 'Microsoft.PowerShell_profile.ps1')
    ]
  }
  return [join(homedir(), '.zshrc'), join(homedir(), '.bashrc')]
}

// ---------- Encoding-preserving file IO ----------

type Enc = 'utf8' | 'utf8-bom' | 'utf16le' | 'utf16be'

function sniffEncoding(buf: Buffer): Enc {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return 'utf16le'
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return 'utf16be'
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return 'utf8-bom'
  return 'utf8'
}

function swapBytes(buf: Buffer): Buffer {
  const out = Buffer.from(buf)
  out.swap16()
  return out
}

function decode(buf: Buffer, enc: Enc): string {
  switch (enc) {
    case 'utf16le':
      return buf.subarray(2).toString('utf16le')
    case 'utf16be':
      return swapBytes(buf.subarray(2)).toString('utf16le')
    case 'utf8-bom':
      return buf.subarray(3).toString('utf8')
    default:
      return buf.toString('utf8')
  }
}

function encode(text: string, enc: Enc): Buffer {
  switch (enc) {
    case 'utf16le':
      return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')])
    case 'utf16be':
      return Buffer.concat([Buffer.from([0xfe, 0xff]), swapBytes(Buffer.from(text, 'utf16le'))])
    case 'utf8-bom':
      return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')])
    default:
      return Buffer.from(text, 'utf8')
  }
}

// ---------- Managed block ----------

function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

function shQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

export function renderBlock(cfg: ShortcutsConfig): string {
  if (cfg.paths.length === 0 && cfg.accounts.length === 0) return ''
  const lines: string[] = [
    `${START_MARKER}  (managed by LightClaude - do not edit between markers)`
  ]
  if (IS_WIN) {
    for (const p of cfg.paths) {
      lines.push(`function ${p.name} { Set-Location -LiteralPath ${psQuote(p.path)} }`)
    }
    for (const a of cfg.accounts) {
      lines.push(
        `function ${a.name} { $env:CLAUDE_CONFIG_DIR = ${psQuote(a.configDir)}; & claude.exe @args }`
      )
    }
  } else {
    for (const p of cfg.paths) {
      lines.push(`${p.name}() { cd ${shQuote(p.path)}; }`)
    }
    for (const a of cfg.accounts) {
      lines.push(`${a.name}() { CLAUDE_CONFIG_DIR=${shQuote(a.configDir)} claude "$@"; }`)
    }
  }
  lines.push(END_MARKER)
  return lines.join(EOL)
}

/** Strip every balanced managed region (self-heals duplicated blocks). */
function stripManagedRegions(text: string): { stripped: string; corrupted: boolean } {
  const starts = text.split('\n').filter((l) => l.includes(START_MARKER)).length
  const ends = text.split('\n').filter((l) => l.includes(END_MARKER)).length
  if (starts !== ends) return { stripped: text, corrupted: true }
  const re = new RegExp(
    `[ \\t]*${escapeRe(START_MARKER)}[\\s\\S]*?${escapeRe(END_MARKER)}[ \\t]*\\r?\\n?`,
    'g'
  )
  return { stripped: text.replace(re, ''), corrupted: false }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Rewrite one profile's managed block. Returns null on success (or no-op),
 * an error message otherwise. Never touches a byte outside marker regions.
 */
export function writeManagedBlock(file: string, block: string): string | null {
  try {
    // New files: BOM on Windows so PowerShell 5.1 reads UTF-8; a BOM would
    // break POSIX shells, so plain utf8 elsewhere.
    let enc: Enc = IS_WIN ? 'utf8-bom' : 'utf8'
    let original: Buffer | null = null
    let text = ''
    if (existsSync(file)) {
      original = readFileSync(file)
      enc = sniffEncoding(original)
      text = decode(original, enc)
    }

    const { stripped, corrupted } = stripManagedRegions(text)
    if (corrupted) {
      return `managed markers look corrupted in ${file} — fix the file manually`
    }

    let next = stripped.replace(/\s+$/, '')
    if (block) {
      next = next ? `${next}${EOL}${EOL}${block}${EOL}` : `${block}${EOL}`
    } else if (next) {
      next += EOL
    } else {
      next = ''
    }

    // 5.1 reads BOM-less files as ANSI — add a BOM when the block needs UTF-8.
    let outEnc = enc
    if (IS_WIN && enc === 'utf8' && /[^\x00-\x7f]/.test(next)) outEnc = 'utf8-bom'

    const out = encode(next, outEnc)
    if (original && out.equals(original)) return null // no-op: avoid mtime churn

    mkdirSync(dirname(file), { recursive: true })
    const tmp = file + '.tmp'
    writeFileSync(tmp, out)
    renameSync(tmp, file)
    return null
  } catch (err) {
    return `${file}: ${err instanceof Error ? err.message : String(err)}`
  }
}

// ---------- Validation ----------

/** PowerShell resolves aliases before functions — these names would never run. */
const RESERVED = new Set(
  (
    'if else elseif for foreach while do switch function return try catch finally ' +
    'param begin process end break continue in exit throw trap class enum filter workflow ' +
    'cd chdir sl dir ls gci cat gc type cp copy cpi mv move mi rm del ri erase echo write ' +
    'pwd gl cls clear set sv start saps kill spps sleep sort where ft fl fw gm gp h history ' +
    'icm iex man md mkdir ni popd pushd ps r rd rmdir select tee help measure group compare ' +
    'diff fc gi gv nv ii ipmo gal gcm ghy pd curl wget claude'
  ).split(/\s+/)
)

export function validateConfig(cfg: ShortcutsConfig): string[] {
  const errors: string[] = []
  const seen = new Set<string>()
  const all = [
    ...cfg.paths.map((p) => ({ name: p.name, target: p.path, kind: 'path' })),
    ...cfg.accounts.map((a) => ({ name: a.name, target: a.configDir, kind: 'account' }))
  ]
  for (const { name, target, kind } of all) {
    if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(name)) {
      errors.push(`"${name}": invalid name (letters, digits, - and _ only)`)
      continue
    }
    const lower = name.toLowerCase()
    if (RESERVED.has(lower)) {
      errors.push(`"${name}": reserved PowerShell command/alias — pick another name`)
    }
    if (seen.has(lower)) {
      errors.push(`"${name}": duplicate name`)
    }
    seen.add(lower)
    if (!target.trim()) {
      errors.push(`"${name}": ${kind === 'path' ? 'folder' : 'config dir'} is empty`)
    }
  }
  return errors
}

// ---------- Import parser ----------

/** Expand the variable forms the user's profile actually uses. */
function expandVars(value: string): string | null {
  const home = homedir()
  let expanded = value
    .replace(/\$\{env:USERPROFILE\}/gi, home)
    .replace(/\$env:USERPROFILE/gi, home)
    .replace(/\$\{HOME\}/g, home)
    .replace(/\$HOME\b/g, home)
  if (!IS_WIN && expanded.startsWith('~/')) expanded = home + expanded.slice(1)
  if (expanded.includes('$')) return null // something we can't resolve — skip
  return expanded.trim()
}

// PowerShell: `function name { ... }` — POSIX: `name() { ... }` or `function name { ... }`
const FUNC_RE = IS_WIN
  ? /function\s+([A-Za-z_][\w-]*)\s*\{([^{}]*)\}/g
  : /(?:function\s+)?([A-Za-z_][\w-]*)\s*(?:\(\)\s*)?\{([^{}]*)\}/g
const PATH_BODY_RE = IS_WIN
  ? /^\s*(?:cd|chdir|sl|Set-Location)(?:\s+-(?:LiteralPath|Path))?\s+(['"])(.*?)\1\s*;?\s*$/i
  : /^\s*(?:cd|builtin\s+cd)\s+(?:--\s+)?(['"])(.*?)\1\s*;?\s*$/
const ACCOUNT_DIR_RE = IS_WIN
  ? /\$env:CLAUDE_CONFIG_DIR\s*=\s*(['"])(.*?)\1/i
  : /(?:export\s+)?CLAUDE_CONFIG_DIR=(['"]?)(.*?)\1(?:\s|;|$)/
const ACCOUNT_EXEC_RE = IS_WIN
  ? /&\s*(['"]?)claude(?:\.exe)?\1\s*(?:\$args|@args)/i
  : /\bclaude\b/

export function parseProfiles(files: string[]): ShortcutsImportResult {
  const paths = new Map<string, { name: string; path: string }>()
  const accounts = new Map<string, { name: string; configDir: string }>()
  let skipped = 0

  for (const file of files) {
    if (!existsSync(file)) continue
    let text: string
    try {
      const buf = readFileSync(file)
      text = decode(buf, sniffEncoding(buf))
    } catch {
      continue
    }
    const { stripped } = stripManagedRegions(text) // never re-import our own block

    FUNC_RE.lastIndex = 0
    for (let m = FUNC_RE.exec(stripped); m; m = FUNC_RE.exec(stripped)) {
      const name = m[1]
      const body = m[2]
      const key = name.toLowerCase()

      const pathMatch = PATH_BODY_RE.exec(body)
      if (pathMatch) {
        const expanded = expandVars(pathMatch[2])
        if (expanded === null) {
          skipped++
        } else {
          // later definitions win, matching shell shadowing
          accounts.delete(key)
          paths.set(key, { name, path: expanded })
        }
        continue
      }

      const dirMatch = ACCOUNT_DIR_RE.exec(body)
      if (dirMatch && ACCOUNT_EXEC_RE.test(body)) {
        const expanded = expandVars(dirMatch[2])
        if (expanded === null) {
          skipped++
        } else {
          paths.delete(key)
          accounts.set(key, { name, configDir: expanded })
        }
      }
    }
  }

  return { paths: [...paths.values()], accounts: [...accounts.values()], skipped }
}

/** Profile candidates in shell load order (later definitions win). */
export function importCandidates(): string[] {
  if (IS_WIN) {
    const docs = app.getPath('documents')
    return [
      join(docs, 'WindowsPowerShell', 'profile.ps1'),
      join(docs, 'WindowsPowerShell', 'Microsoft.PowerShell_profile.ps1'),
      join(docs, 'PowerShell', 'profile.ps1'),
      join(docs, 'PowerShell', 'Microsoft.PowerShell_profile.ps1')
    ]
  }
  const home = homedir()
  return [
    join(home, '.profile'),
    join(home, '.bash_profile'),
    join(home, '.bashrc'),
    join(home, '.zprofile'),
    join(home, '.zshrc')
  ]
}

// ---------- Save orchestration ----------

export function saveShortcuts(cfg: ShortcutsConfig): ShortcutsSaveResult {
  const errors = validateConfig(cfg)
  if (errors.length > 0) return { ok: false, profilesWritten: [], errors }

  saveShortcutsJson(cfg)

  const block = renderBlock(cfg)
  const written: string[] = []
  for (const file of profileTargets()) {
    const err = writeManagedBlock(file, block)
    if (err) errors.push(err)
    else written.push(file)
  }
  return { ok: errors.length === 0, profilesWritten: written, errors }
}
