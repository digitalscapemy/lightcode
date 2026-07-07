import { app } from 'electron'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { PersistedState } from '../shared/types'

function stateFile(): string {
  return join(app.getPath('userData'), 'state.json')
}

export function loadState(): PersistedState | null {
  try {
    const file = stateFile()
    if (!existsSync(file)) return null
    const raw = readFileSync(file, 'utf8').replace(/^﻿/, '')
    const parsed = JSON.parse(raw)
    if (parsed?.version !== 1 || !Array.isArray(parsed.tabs)) return null
    return parsed as PersistedState
  } catch {
    return null
  }
}

export function saveState(state: PersistedState): void {
  try {
    const file = stateFile()
    const tmp = file + '.tmp'
    writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8')
    renameSync(tmp, file)
  } catch (err) {
    console.error('saveState failed:', err)
  }
}
