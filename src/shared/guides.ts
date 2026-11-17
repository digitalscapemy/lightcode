/**
 * Step-by-step guides for the things Light Code cannot do for the user.
 *
 * Some fixes belong to the user, not the app: Windows decides whether
 * PowerShell loads a profile, and whether an app may write to Documents. Light
 * Code will not change those settings behind anyone's back (warn, never
 * block), but it should never leave the user with only an error either. Each
 * guide says what happened, why, and exactly what to do, with the command to
 * copy or the settings page to open.
 */

export type GuideId =
  | 'execution-policy'
  | 'controlled-folder-access'
  | 'path-after-install'
  | 'install-failed'
  | 'git-missing'

/** OS settings pages a guide may open. Fixed list: the renderer names a key, never a URI. */
export type SystemPage = 'windows-ransomware-protection'

export interface GuideStep {
  text: string
  /** A command to copy and run. */
  command?: string
  /** A settings page to open from the guide. */
  page?: SystemPage
  pageLabel?: string
  /** A web page to open (http/https only). */
  url?: string
  urlLabel?: string
}

/** One thing Light Code needs to be allowed to do, and whether it can. */
export interface PermissionCheck {
  id: string
  label: string
  ok: boolean
  /** Where, or why not. */
  detail: string
  /** The guide that fixes it, when the fix is the user's to make. */
  guide?: GuideId
}

export interface Guide {
  id: GuideId
  title: string
  /** One or two sentences: what happened and why. */
  why: string
  steps: GuideStep[]
  /** True when no admin rights are needed, which is worth saying. */
  noAdmin?: boolean
}

export const GUIDES: Record<GuideId, Guide> = {
  'execution-policy': {
    id: 'execution-policy',
    title: 'Let PowerShell load your shortcuts',
    why:
      'Windows is set to block PowerShell scripts, so $PROFILE (where your shortcuts are saved) does not load in ' +
      'other terminals. Light Code panes already have your shortcuts; this is only for terminals outside Light Code.',
    noAdmin: true,
    steps: [
      { text: 'Open PowerShell (a Light Code pane is fine).' },
      { text: 'Run this, then answer Y if it asks:', command: 'Set-ExecutionPolicy -Scope CurrentUser RemoteSigned' },
      { text: 'Open a new terminal. Your shortcuts are there.' }
    ]
  },
  'controlled-folder-access': {
    id: 'controlled-folder-access',
    title: 'Allow Light Code to save to Documents',
    why:
      'Windows Security (Controlled folder access) blocked Light Code from writing to your Documents folder, ' +
      'where $PROFILE lives. Your shortcuts are saved and work in Light Code panes; this lets other terminals see them.',
    noAdmin: true,
    steps: [
      {
        text: 'Open Windows Security, Ransomware protection.',
        page: 'windows-ransomware-protection',
        pageLabel: 'Open Ransomware protection'
      },
      { text: 'Choose "Allow an app through Controlled folder access", then "Add an allowed app".' },
      { text: 'Pick "Recently blocked apps" and add Light Code.' },
      { text: 'Come back and press Save again.' }
    ]
  },
  'path-after-install': {
    id: 'path-after-install',
    title: 'Installed, but the command is not found',
    why:
      'The installer added its folder to your PATH, but terminals that were already open still use the old one.',
    steps: [
      { text: 'Open a new pane. Light Code gives new panes the updated PATH.' },
      { text: 'Still not found? Close and reopen Light Code, or sign out of Windows and back in.' }
    ]
  },
  'git-missing': {
    id: 'git-missing',
    title: 'Install Git',
    why:
      'Worktrees, Fan-out and the Worktrees panel use git. Everything else in Light Code works without it.',
    steps: [
      {
        text: 'Download Git from the official site and run the installer. The default options are fine.',
        url: 'https://git-scm.com/downloads',
        urlLabel: 'Open git-scm.com'
      },
      { text: 'Open a new pane. Light Code picks up the updated PATH, and "git --version" answers.' }
    ]
  },
  'install-failed': {
    id: 'install-failed',
    title: 'If the install did not work',
    why: 'The install ran in a terminal pane, so the real error is right there.',
    steps: [
      { text: 'Read the last lines in the install pane. A 403 or a timeout usually means a network, proxy or VPN problem.' },
      { text: '"running scripts is disabled": use the guide "Let PowerShell load your shortcuts" first, then try again.' },
      { text: 'Antivirus or Controlled folder access can block installers. Allow the installer, then run it again.' },
      { text: 'The vendor page has every other way to install. Open it from the tool’s row.' }
    ]
  }
}

/** The URI behind a settings-page key, for this platform, or null. */
export function systemPageUri(page: unknown, platform: string): string | null {
  if (page === 'windows-ransomware-protection' && platform === 'win32') return 'windowsdefender://ransomwareprotection'
  return null
}
