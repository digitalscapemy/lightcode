import type { LightClaudeApi } from '../../shared/ipc'

declare global {
  interface Window {
    lightclaude: LightClaudeApi
  }
}

export {}
