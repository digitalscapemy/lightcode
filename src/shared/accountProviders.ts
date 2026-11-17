/**
 * Which agent an account shortcut logs in to, and how one login is kept apart
 * from another. Pure data, shared by main (which writes the shell functions)
 * and the renderer (which draws the picker).
 *
 *   Claude Code   CLAUDE_CONFIG_DIR   login, settings and history in that folder
 *   Codex CLI     CODEX_HOME          auth.json, config and history in that folder
 *   Antigravity   USERPROFILE / HOME  settings and conversations in that folder.
 *                 The Google login itself lives in the system credential store
 *                 (checked with agy 1.5.2: a fresh home still signed in), so
 *                 every Antigravity entry shares one login. Said in the UI.
 */

import type { AccountShortcut } from './types'

export type AccountProvider = 'claude' | 'codex' | 'antigravity'

export interface ProviderDef {
  id: AccountProvider
  label: string
  /** The command the shortcut runs. */
  bin: string
  /** Folder name prefix for a new account under the home directory. */
  dirPrefix: string
  /** The folder the CLI uses when nothing is set. */
  defaultDir: string
  /** One line shown in the editor about what a separate folder buys. */
  note: string
}

export const PROVIDERS: Readonly<Record<AccountProvider, ProviderDef>> = {
  claude: {
    id: 'claude',
    label: 'Claude',
    bin: 'claude',
    dirPrefix: '.claude-',
    defaultDir: '.claude',
    note: 'Each folder is its own Claude login, with its own settings and history.'
  },
  codex: {
    id: 'codex',
    label: 'Codex',
    bin: 'codex',
    dirPrefix: '.codex-',
    defaultDir: '.codex',
    note: 'Each folder is its own Codex login (CODEX_HOME), with its own config and history.'
  },
  antigravity: {
    id: 'antigravity',
    label: 'Antigravity',
    bin: 'agy',
    dirPrefix: '.agy-',
    defaultDir: '.gemini',
    note: 'Keeps settings and conversations apart. The Google login is shared: Antigravity keeps it in the system credential store.'
  }
}

export const PROVIDER_IDS = Object.keys(PROVIDERS) as AccountProvider[]

/** An entry's provider; entries saved before providers existed are Claude. */
export function providerOf(a: Pick<AccountShortcut, 'provider'>): AccountProvider {
  return a.provider && a.provider in PROVIDERS ? a.provider : 'claude'
}

/**
 * The function body that runs the provider's CLI with this account's folder.
 * PowerShell variant. The folder is already quoted by the caller.
 *
 * Claude keeps its old one-liner byte for byte (an existing profile block must
 * not churn). Codex and Antigravity restore what they change, so the shell the
 * shortcut ran in is left exactly as it was.
 */
export function psAccountBody(provider: AccountProvider, quotedDir: string): string {
  switch (provider) {
    case 'codex':
      return `$o = $env:CODEX_HOME; $env:CODEX_HOME = ${quotedDir}; try { & codex @args } finally { $env:CODEX_HOME = $o }`
    case 'antigravity':
      return (
        `$o = $env:USERPROFILE; $h = $env:HOME; $env:USERPROFILE = ${quotedDir}; $env:HOME = ${quotedDir}; ` +
        `try { & agy @args } finally { $env:USERPROFILE = $o; $env:HOME = $h }`
      )
    default:
      return `$env:CLAUDE_CONFIG_DIR = ${quotedDir}; & claude @args`
  }
}

/** POSIX variant: the variable is set for the one command only. */
export function shAccountBody(provider: AccountProvider, quotedDir: string): string {
  switch (provider) {
    case 'codex':
      return `CODEX_HOME=${quotedDir} codex "$@";`
    case 'antigravity':
      return `HOME=${quotedDir} agy "$@";`
    default:
      return `CLAUDE_CONFIG_DIR=${quotedDir} claude "$@";`
  }
}
