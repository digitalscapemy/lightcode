import { execFileSync } from 'child_process'
import { app } from 'electron'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { basename, join } from 'path'
import { hookPaths } from './agentHooks'
import { lcPowerShellFunction, lcScriptPath, lcShellFunction } from './lcClient'
import { LC_SYSTEM_HINT } from '../shared/lc'

export interface ShellInfo {
  file: string
  args: string[]
  /** Extra environment merged into the pty's env at spawn. */
  env?: Record<string, string>
}

let cached: ShellInfo | null = null

/**
 * Path of the app's generated agent-hook settings, once installed.
 *
 * This is how Claude Code learns about our hooks, and the reason nothing here
 * ever edits ~/.claude/settings.json: the shell integration defines a `claude`
 * wrapper that adds `--settings <this file>`, which Claude Code merges on top
 * of the user's own settings. The hooks therefore exist only inside Light Code's
 * panes — a plain terminal is untouched, and there is nothing to uninstall.
 */
let hookSettings: string | null = null

/**
 * Whether the generated rc files should define `lc`.
 *
 * Set once the client script exists. The function is defined even while the
 * switch is off — the command then explains that it is off, which is a better
 * answer than "command not found" to an agent trying to work out what it has.
 */
let lcInstalled = false

export function setLcInstalled(on: boolean): void {
  if (on === lcInstalled) return
  lcInstalled = on
  cached = null
}

function posixLc(): string {
  return lcInstalled ? lcShellFunction(process.execPath, lcScriptPath()) : ''
}

export function setHookSettings(file: string | null): void {
  if (file === hookSettings) return
  hookSettings = file
  cached = null // integration files are rewritten on the next detectShell()
}

/** Per-pty environment the reporter script needs. Empty when hooks are off. */
export function hookEnv(): Record<string, string> {
  if (!hookSettings) return {}
  return { LIGHTCODE_HOOK_SETTINGS: hookSettings, LIGHTCODE_HOOK_DIR: hookPaths().spool }
}

/**
 * What the claude wrapper needs to mention `lc` to an agent.
 *
 * The socket path is passed so the wrapper can check whether the switch is on
 * at the moment claude launches, rather than when the shell started — the
 * switch can be flipped while a pane sits at its prompt, and an rc file read
 * minutes ago cannot know that.
 */
export function lcEnv(socket: string | null): Record<string, string> {
  if (!lcInstalled || socket === null) return {}
  return { LIGHTCODE_LC_SOCKET: socket, LIGHTCODE_LC_HINT: LC_SYSTEM_HINT }
}

/**
 * A `claude` that carries the app's hook settings.
 *
 * Deliberately skipped when the user already defines their own `claude`
 * function: theirs is a customisation we have no business replacing, and the
 * badge degrades to transcript-only inference, which is what it did before.
 * An *alias* needs no such care — it expands before function lookup, so its
 * arguments arrive in "$@" and survive.
 */
function posixClaudeWrapper(): string {
  if (!hookSettings) return ''
  return [
    '',
    '# Light Code: merge the app hook settings into Claude Code, so a pane can',
    "# tell a permission prompt from a slow tool. The user's own claude",
    '# function, if they have one, is left alone.',
    'if ! typeset -f claude >/dev/null 2>&1; then',
    '  claude() {',
    '    # Checked here, not when this file was read: the agent CLI switch can be',
    '    # flipped while a pane sits at its prompt, and the socket only exists',
    '    # while it is on — so its presence IS the switch, read at launch time.',
    '    if [ -S "$LIGHTCODE_LC_SOCKET" ] && [ -n "$LIGHTCODE_LC_HINT" ]; then',
    '      set -- --append-system-prompt "$LIGHTCODE_LC_HINT" "$@"',
    '    fi',
    '    if [ -n "$LIGHTCODE_HOOK_SETTINGS" ]; then',
    '      set -- --settings "$LIGHTCODE_HOOK_SETTINGS" "$@"',
    '    fi',
    '    command claude "$@"',
    '  }',
    'fi'
  ].join('\n')
}

/** The same wrapper for PowerShell, appended to the startup -Command. */
function psClaudeWrapper(): string {
  if (!hookSettings) return ''
  return (
    '$global:__lcClaudeExe = (Get-Command claude -CommandType Application ' +
    '-ErrorAction SilentlyContinue | Select-Object -First 1).Source; ' +
    'if ($global:__lcClaudeExe -and -not (Get-Command claude -CommandType Function ' +
    '-ErrorAction SilentlyContinue)) { ' +
    'function global:claude { $a = @(); ' +
    'if ($env:LIGHTCODE_HOOK_SETTINGS) { $a += \'--settings\'; $a += $env:LIGHTCODE_HOOK_SETTINGS }; ' +
    // No socket test here: a named pipe is not a file Test-Path can see the way
    // a unix socket is, so Windows mentions lc whenever it is installed. The
    // worst case is an agent running `lc --help` and being told it is off.
    'if ($env:LIGHTCODE_LC_HINT) { $a += \'--append-system-prompt\'; $a += $env:LIGHTCODE_LC_HINT }; ' +
    '& $global:__lcClaudeExe @a @args } }'
  )
}

/**
 * Shell integration: every prompt render emits OSC 9;9 with the current
 * directory — the same sequence Windows Terminal uses. ptyManager parses it
 * to track each pane's live cwd for the token-usage badge and cwd restore.
 */
const psPromptHook =
  '$global:__lcPrompt = $function:prompt; ' +
  'function global:prompt { ' +
  '"$([char]27)]9;9;$($executionContext.SessionState.Path.CurrentLocation.ProviderPath)$([char]7)" + (& $global:__lcPrompt) ' +
  '}'

export function detectShell(): ShellInfo {
  if (cached) return cached
  cached = process.platform === 'win32' ? detectWindowsShell() : detectPosixShell()
  return cached
}

// ---------- Windows ----------

function detectWindowsShell(): ShellInfo {
  let file = ''
  const wellKnown = join(
    process.env['ProgramFiles'] ?? 'C:\\Program Files',
    'PowerShell',
    '7',
    'pwsh.exe'
  )
  if (existsSync(wellKnown)) {
    file = wellKnown
  } else {
    try {
      const out = execFileSync('where.exe', ['pwsh.exe'], {
        encoding: 'utf8',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore']
      })
      const first = out.split(/\r?\n/)[0]?.trim()
      if (first && existsSync(first)) file = first
    } catch {
      // pwsh not on PATH
    }
  }
  if (!file) file = 'powershell.exe'

  const parts = [psPromptHook, psClaudeWrapper()]
  if (lcInstalled) parts.push(lcPowerShellFunction(process.execPath, lcScriptPath()))
  const startup = parts.filter(Boolean).join('; ')
  return { file, args: ['-NoLogo', '-NoExit', '-Command', startup] }
}

// ---------- macOS / Linux ----------

function detectPosixShell(): ShellInfo {
  const file =
    process.env['SHELL'] ?? (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash')
  const name = basename(file)

  try {
    if (name === 'zsh') return zshShell(file)
    if (name === 'bash') return bashShell(file)
  } catch {
    // integration files couldn't be written — run the bare shell instead
  }
  // Unknown shell (fish, nu, ...): no cwd hook; badge falls back to spawn cwd.
  return { file, args: ['-l'] }
}

/**
 * zsh: point ZDOTDIR at our stub directory. Each stub sources the user's real
 * startup file, and .zshrc additionally installs a precmd hook that reports
 * the cwd. Login shell (-l) so PATH from .zprofile (Homebrew etc.) loads.
 */
function zshShell(file: string): ShellInfo {
  const dir = join(app.getPath('userData'), 'shell-integration', 'zsh')
  mkdirSync(dir, { recursive: true })

  const sourceUser = (rcName: string): string =>
    [
      'ZDOTDIR="$LC_USER_ZDOTDIR"',
      `[[ -f "$ZDOTDIR/${rcName}" ]] && . "$ZDOTDIR/${rcName}"`,
      'ZDOTDIR="$LC_APP_ZDOTDIR"'
    ].join('\n')

  writeFileSync(join(dir, '.zshenv'), sourceUser('.zshenv') + '\n')
  writeFileSync(join(dir, '.zprofile'), sourceUser('.zprofile') + '\n')
  writeFileSync(join(dir, '.zlogin'), sourceUser('.zlogin') + '\n')
  writeFileSync(
    join(dir, '.zshrc'),
    sourceUser('.zshrc') +
      '\n' +
      '__lc_report_cwd() { printf \'\\033]9;9;%s\\007\' "$PWD"; }\n' +
      'typeset -ga precmd_functions\n' +
      'precmd_functions+=(__lc_report_cwd)\n' +
      posixClaudeWrapper() +
      '\n' +
      posixLc() +
      '\n' +
      // leave the user's ZDOTDIR for nested shells
      'ZDOTDIR="$LC_USER_ZDOTDIR"\n'
  )

  return {
    file,
    args: ['-l'],
    env: {
      ZDOTDIR: dir,
      LC_APP_ZDOTDIR: dir,
      LC_USER_ZDOTDIR: process.env['ZDOTDIR'] ?? homedir()
    }
  }
}

/** bash: a custom rcfile that loads the user's startup files, then hooks. */
function bashShell(file: string): ShellInfo {
  const dir = join(app.getPath('userData'), 'shell-integration', 'bash')
  mkdirSync(dir, { recursive: true })
  const rc = join(dir, 'lc-bashrc.sh')
  writeFileSync(
    rc,
    [
      '[ -f /etc/profile ] && . /etc/profile',
      '[ -f "$HOME/.bash_profile" ] && . "$HOME/.bash_profile" || {',
      '  [ -f "$HOME/.bash_login" ] && . "$HOME/.bash_login" || {',
      '    [ -f "$HOME/.profile" ] && . "$HOME/.profile"; }; }',
      '[ -f "$HOME/.bashrc" ] && . "$HOME/.bashrc"',
      '__lc_report_cwd() { printf \'\\033]9;9;%s\\007\' "$PWD"; }',
      'PROMPT_COMMAND="__lc_report_cwd${PROMPT_COMMAND:+;$PROMPT_COMMAND}"',
      posixClaudeWrapper(),
      posixLc(),
      ''
    ].join('\n')
  )
  return { file, args: ['--rcfile', rc, '-i'] }
}
