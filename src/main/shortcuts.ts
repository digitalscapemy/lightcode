import { app } from 'electron'
import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'
import { PROVIDERS, providerOf, psAccountBody, shAccountBody } from '../shared/accountProviders'
import { psSingleQuote } from '../shared/psQuote'
import { isInside, isValidCategory } from '../shared/shortcutPaths'
import type {
  AccountShortcut,
  ShortcutsConfig,
  ShortcutsImportResult,
  ShortcutsSaveResult
} from '../shared/types'
import type { GuideId } from '../shared/guides'

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
      const cfg: ShortcutsConfig = {
        version: 1,
        paths: Array.isArray(parsed.paths) ? parsed.paths : [],
        accounts: Array.isArray(parsed.accounts) ? parsed.accounts : []
      }
      // An unknown provider (a later version's, or a hand edit) reads as Claude.
      for (const a of cfg.accounts) {
        if (a && a.provider !== undefined && providerOf(a) !== a.provider) delete a.provider
      }
      if (typeof parsed.projectRoot === 'string' && parsed.projectRoot.trim()) {
        cfg.projectRoot = parsed.projectRoot
      }
      if (Array.isArray(parsed.categories)) {
        cfg.categories = parsed.categories.filter(
          (c): c is string => typeof c === 'string' && isValidCategory(c)
        )
      }
      return cfg
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

/** Also escapes the curly quotes PowerShell treats as ' (see psSingleQuote). */
const psQuote = psSingleQuote

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
      // `claude` rather than `claude.exe`: inside Light Code that resolves to
      // the wrapper carrying the agent-hook settings, and outside it PowerShell
      // finds claude.exe on PATH through PATHEXT exactly as before.
      lines.push(`function ${a.name} { ${psAccountBody(providerOf(a), psQuote(a.configDir))} }`)
    }
  } else {
    for (const p of cfg.paths) {
      lines.push(`${p.name}() { cd ${shQuote(p.path)}; }`)
    }
    for (const a of cfg.accounts) {
      lines.push(`${a.name}() { ${shAccountBody(providerOf(a), shQuote(a.configDir))} }`)
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
      return `managed markers look corrupted in ${file}. Fix the file manually.`
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
    return describeWriteError(file, err)
  }
}

// ---------- Pane startup (Windows) ----------

const SAFE_NAME = /^[A-Za-z_][A-Za-z0-9_-]*$/

/**
 * The shortcuts as one line of PowerShell for a pane's `-Command` startup.
 *
 * A fresh Windows install has the execution policy `Restricted`, which stops
 * `$PROFILE` from loading at all — so the functions saved there never exist,
 * and to the user it looks as if the save did nothing. `-Command` text is not
 * a script file and no policy applies to it, so defining them here makes them
 * work in every Light Code pane whatever the policy is. On a machine where the
 * profile does load, this simply redefines the same functions.
 *
 * Read from shortcuts.json at each spawn, so a new pane always has the latest
 * save. Entries that would not pass validateConfig are skipped, never quoted
 * into a command: a hand-edited file must not be able to inject code.
 */
export function psStartupShortcuts(cfg: ShortcutsConfig): string {
  const ok = (name: unknown): name is string =>
    typeof name === 'string' && SAFE_NAME.test(name) && !RESERVED.has(name.toLowerCase())
  const defs: string[] = []
  for (const p of cfg.paths) {
    if (ok(p.name) && typeof p.path === 'string' && p.path.trim()) {
      defs.push(`function global:${p.name} { Set-Location -LiteralPath ${psQuote(p.path)} }`)
    }
  }
  for (const a of cfg.accounts) {
    if (ok(a.name) && typeof a.configDir === 'string' && a.configDir.trim()) {
      defs.push(`function global:${a.name} { ${psAccountBody(providerOf(a), psQuote(a.configDir))} }`)
    }
  }
  return defs.join('; ')
}

/**
 * The effective PowerShell execution policy, or null when it cannot be read.
 * Only asked on save (it starts a PowerShell, ~0.3s), never on the hot path.
 */
export function effectiveExecutionPolicy(): string | null {
  if (!IS_WIN) return null
  try {
    const out = execFileSync(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'Get-ExecutionPolicy'],
      { encoding: 'utf8', windowsHide: true, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }
    )
    return out.trim() || null
  } catch {
    return null
  }
}

/** A warning when the policy keeps $PROFILE from loading, else null. */
export function profilePolicyWarning(policy: string | null): string | null {
  if (!policy) return null
  const p = policy.toLowerCase()
  if (p !== 'restricted' && p !== 'allsigned' && p !== 'undefined') return null
  const shown = p === 'undefined' ? 'Restricted' : policy
  return (
    `PowerShell's execution policy is ${shown}, so other terminals will not load $PROFILE and ` +
    `will not see these shortcuts (Light Code panes get them anyway). To use them everywhere, ` +
    `run once: Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`
  )
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
    'diff fc gi gv nv ii ipmo gal gcm ghy pd curl wget claude codex agy'
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
      errors.push(`"${name}": reserved PowerShell command/alias, pick another name`)
    }
    if (seen.has(lower)) {
      errors.push(`"${name}": duplicate name`)
    }
    seen.add(lower)
    if (!target.trim()) {
      errors.push(`"${name}": ${kind === 'path' ? 'folder' : 'config dir'} is empty`)
    }
  }
  for (const c of cfg.categories ?? []) {
    if (!isValidCategory(c)) errors.push(`category "${c}": not a valid folder name`)
  }
  for (const p of cfg.paths) {
    if (p.category && !isValidCategory(p.category)) {
      errors.push(`"${p.name}": category "${p.category}" is not a valid folder name`)
    }
  }
  return errors
}

/**
 * Create the folders a save points at but which do not exist yet — only the
 * ones this feature owns: projects under the main projects folder and
 * `.claude-*` account dirs under home. A hand-typed path elsewhere is never
 * created, so a typo cannot scatter empty folders around the disk.
 */
export function createMissingFolders(
  cfg: ShortcutsConfig,
  home: string
): { created: string[]; warnings: string[] } {
  const created: string[] = []
  const warnings: string[] = []
  const wanted: string[] = []
  if (cfg.projectRoot) {
    for (const p of cfg.paths) {
      if (isInside(cfg.projectRoot, p.path, IS_WIN)) wanted.push(p.path)
    }
  }
  for (const a of cfg.accounts) {
    const base = a.configDir.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? ''
    if (base.startsWith(PROVIDERS[providerOf(a)].dirPrefix) && isInside(home, a.configDir, IS_WIN)) wanted.push(a.configDir)
  }
  for (const dir of wanted) {
    if (existsSync(dir)) continue
    try {
      mkdirSync(dir, { recursive: true })
      created.push(dir)
    } catch (err) {
      warnings.push(`could not create ${dir}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return { created, warnings }
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
const CODEX_DIR_RE = IS_WIN
  ? /\$env:CODEX_HOME\s*=\s*(['"])(.*?)/i
  : /(?:export\s+)?CODEX_HOME=(['"]?)(.*?)(?:\s|;|$)/
const CODEX_EXEC_RE = IS_WIN ? /&\s*(['"]?)codex(?:\.exe)?\s*(?:\$args|@args)/i : /codex/
const ACCOUNT_EXEC_RE = IS_WIN
  ? /&\s*(['"]?)claude(?:\.exe)?\1\s*(?:\$args|@args)/i
  : /\bclaude\b/

export function parseProfiles(files: string[]): ShortcutsImportResult {
  const paths = new Map<string, { name: string; path: string }>()
  const accounts = new Map<string, AccountShortcut>()
  let skipped = 0

  let found = 0
  const unreadable: string[] = []
  for (const file of files) {
    if (!existsSync(file)) continue
    found++
    let text: string
    try {
      const buf = readFileSync(file)
      text = decode(buf, sniffEncoding(buf))
    } catch (err) {
      unreadable.push(`${file}: ${err instanceof Error ? err.message : String(err)}`)
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

      const claudeDir = ACCOUNT_DIR_RE.exec(body)
      const codexDir = CODEX_DIR_RE.exec(body)
      const dirMatch =
        claudeDir && ACCOUNT_EXEC_RE.test(body) ? claudeDir : codexDir && CODEX_EXEC_RE.test(body) ? codexDir : null
      if (dirMatch) {
        const expanded = expandVars(dirMatch[2])
        if (expanded === null) {
          skipped++
        } else {
          paths.delete(key)
          const entry: AccountShortcut = { name, configDir: expanded }
          if (dirMatch === codexDir) entry.provider = 'codex'
          accounts.set(key, entry)
        }
      }
    }
  }

  return { paths: [...paths.values()], accounts: [...accounts.values()], skipped, found, unreadable }
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

/**
 * A write failure in words a person can act on. On Windows an EPERM/EACCES in
 * Documents is nearly always Controlled folder access (ransomware protection),
 * which blocks apps it does not know — it reads like missing admin rights,
 * and running as admin is not the fix.
 */
export function describeWriteError(file: string, err: unknown): string {
  const code = (err as { code?: string })?.code
  const msg = err instanceof Error ? err.message : String(err)
  if (IS_WIN && (code === 'EPERM' || code === 'EACCES')) {
    return (
      `Windows blocked writing ${file}. This is usually Controlled folder access: open ` +
      `Windows Security → Virus & threat protection → Ransomware protection → ` +
      `"Allow an app through Controlled folder access" and add Light Code. No admin rights needed.`
    )
  }
  return `${file}: ${msg}`
}

/**
 * Save the shortcuts. Only two things fail a save: an invalid entry, or
 * shortcuts.json itself not being written — that file is what Light Code
 * panes read, so once it is on disk the shortcuts work there. Writing
 * $PROFILE is for other terminals; when Windows refuses it (Controlled folder
 * access, a read-only file) the save still succeeds and says so as a warning,
 * rather than reporting a save that did happen as one that did not.
 */
export function saveShortcuts(cfg: ShortcutsConfig): ShortcutsSaveResult {
  const errors = validateConfig(cfg)
  if (errors.length > 0) return { ok: false, profilesWritten: [], errors }

  try {
    saveShortcutsJson(cfg)
  } catch (err) {
    return { ok: false, profilesWritten: [], errors: [describeWriteError(shortcutsFile(), err)] }
  }
  const { created, warnings } = createMissingFolders(cfg, homedir())
  const guides: GuideId[] = []
  const policyWarning = profilePolicyWarning(effectiveExecutionPolicy())
  if (policyWarning) {
    warnings.push(policyWarning)
    guides.push('execution-policy')
  }

  const block = renderBlock(cfg)
  const written: string[] = []
  for (const file of profileTargets()) {
    const err = writeManagedBlock(file, block)
    if (err) {
      warnings.push(`${err}. Light Code panes still have these shortcuts.`)
      if (/Controlled folder access/.test(err) && !guides.includes('controlled-folder-access')) {
        guides.push('controlled-folder-access')
      }
    }
    else written.push(file)
  }
  return { ok: true, profilesWritten: written, errors: [], created, warnings, guides }
}
