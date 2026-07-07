import { execFileSync } from 'child_process'
import { app } from 'electron'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { basename, join } from 'path'

export interface ShellInfo {
  file: string
  args: string[]
  /** Extra environment merged into the pty's env at spawn. */
  env?: Record<string, string>
}

let cached: ShellInfo | null = null

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

  return { file, args: ['-NoLogo', '-NoExit', '-Command', psPromptHook] }
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
      ''
    ].join('\n')
  )
  return { file, args: ['--rcfile', rc, '-i'] }
}
