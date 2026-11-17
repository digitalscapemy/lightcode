/**
 * The tools Light Code can check for and install: the agent CLIs, and the
 * system tools agents lean on (WSL, Docker).
 *
 * Install commands are the vendors' own, copied from their official pages
 * (checked 2026-11-17) — Light Code never invents one:
 *   Claude Code      https://code.claude.com/docs/en/setup
 *   Codex CLI        https://github.com/openai/codex (README)
 *   Antigravity CLI  https://antigravity.google/download
 *   WSL              https://learn.microsoft.com/windows/wsl/install
 *   Docker           https://docs.docker.com/get-started/get-docker/
 *
 * Every one of them is optional. Light Code runs without any; a missing tool
 * is shown as "Not installed" with one Install button, never as an error.
 *
 * Installing means typing that command into a new terminal pane, in view: the
 * user sees every line, can stop it, and reads the real error if it fails.
 */

export type ToolId = 'claude' | 'codex' | 'antigravity' | 'wsl' | 'docker'

export interface ToolDef {
  id: ToolId
  label: string
  /** The command it puts on PATH. */
  bin: string
  /** One line on what it is. */
  blurb: string
  /** Official install commands, by shell family. */
  install: { powershell: string; posix: string }
  /** Where to read more, and what to do if the install fails. */
  docs: string
  /** Folders its official installer uses, relative to the home directory. */
  installDirs: { win32: string[]; posix: string[] }
  /** An agent CLI, or a system tool agents lean on. */
  group: 'agent' | 'system'
  /** Only offered on these platforms (process.platform values). Absent: all. */
  platforms?: string[]
  /** What the install asks of the person beyond a click (admin, restart). */
  installNote?: string
}

export const TOOLS: ToolDef[] = [
  {
    id: 'claude',
    label: 'Claude Code',
    bin: 'claude',
    blurb: "Anthropic's coding agent. The one Light Code is built around.",
    install: {
      powershell: 'irm https://claude.ai/install.ps1 | iex',
      posix: 'curl -fsSL https://claude.ai/install.sh | bash'
    },
    docs: 'https://code.claude.com/docs/en/setup',
    installDirs: { win32: ['.local\\bin'], posix: ['.local/bin'] },
    group: 'agent'
  },
  {
    id: 'codex',
    label: 'Codex CLI',
    bin: 'codex',
    blurb: "OpenAI's coding agent for the terminal.",
    install: {
      powershell: 'powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"',
      posix: 'curl -fsSL https://chatgpt.com/codex/install.sh | sh'
    },
    docs: 'https://github.com/openai/codex',
    installDirs: { win32: ['.local\\bin', 'AppData\\Roaming\\npm'], posix: ['.local/bin'] },
    group: 'agent'
  },
  {
    id: 'antigravity',
    label: 'Antigravity CLI',
    bin: 'agy',
    blurb: "Google's agent CLI (agy).",
    install: {
      powershell: 'irm https://antigravity.google/cli/install.ps1 | iex',
      posix: 'curl -fsSL https://antigravity.google/cli/install.sh | bash'
    },
    docs: 'https://antigravity.google/download',
    installDirs: { win32: ['AppData\\Local\\agy\\bin'], posix: ['.local/bin'] },
    group: 'agent'
  },
  {
    id: 'wsl',
    label: 'WSL',
    bin: 'wsl',
    blurb: 'Windows Subsystem for Linux. Lets agents run Linux tools and scripts.',
    install: {
      // `wsl --install` needs administrator rights; RunAs shows the Windows prompt.
      powershell: "Start-Process wsl.exe -ArgumentList '--install' -Verb RunAs -Wait",
      posix: ''
    },
    docs: 'https://learn.microsoft.com/windows/wsl/install',
    installDirs: { win32: [], posix: [] },
    group: 'system',
    platforms: ['win32'],
    installNote: 'Asks for administrator approval, then a restart of Windows.'
  },
  {
    id: 'docker',
    label: 'Docker',
    bin: 'docker',
    blurb: 'Containers, for agents that build and run services.',
    install: {
      powershell: 'winget install -e --id Docker.DockerDesktop',
      posix:
        'if command -v brew >/dev/null; then brew install --cask docker; else curl -fsSL https://get.docker.com | sudo sh; fi'
    },
    docs: 'https://docs.docker.com/get-started/get-docker/',
    installDirs: { win32: [], posix: [] },
    group: 'system',
    installNote: 'On Windows, Docker Desktop runs on WSL and may ask for a restart.'
  }
]

/** The tools offered on this platform, in table order, optionally one group only. */
export function toolsFor(platform: string, group?: ToolDef['group']): ToolDef[] {
  return TOOLS.filter((t) => (!t.platforms || t.platforms.includes(platform)) && (!group || t.group === group))
}

export interface ToolStatus {
  id: ToolId
  installed: boolean
  /** Where it was found. */
  path?: string
  /** First line of `<bin> --version`, when it answered. */
  version?: string
}

export function toolById(id: string): ToolDef | undefined {
  return TOOLS.find((t) => t.id === id)
}

/** The install command for the shell a pane runs on this platform. */
export function installCommand(tool: ToolDef, platform: string): string {
  return platform === 'win32' ? tool.install.powershell : tool.install.posix
}
