import { execFileSync } from 'child_process'
import { app } from 'electron'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { basename, join } from 'path'
import { hookPaths } from './agentHooks'

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
    '    if [ -n "$LIGHTCODE_HOOK_SETTINGS" ]; then',
    '      command claude --settings "$LIGHTCODE_HOOK_SETTINGS" "$@"',
    '    else',
    '      command claude "$@"',
    '    fi',
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
    'function global:claude { ' +
    'if ($env:LIGHTCODE_HOOK_SETTINGS) { ' +
    '& $global:__lcClaudeExe --settings $env:LIGHTCODE_HOOK_SETTINGS @args } ' +
    'else { & $global:__lcClaudeExe @args } } }'
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

  const wrapper = psClaudeWrapper()
  const startup = wrapper ? `${psPromptHook}; ${wrapper}` : psPromptHook
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
      ''
    ].join('\n')
  )
  return { file, args: ['--rcfile', rc, '-i'] }
}
