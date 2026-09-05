import { app } from 'electron'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import type { PersistedState } from '../shared/types'
import { atomicWrite, claimOwnership, releaseOwnership } from './instance'

function stateFile(): string {
  return join(app.getPath('userData'), 'state.json')
}

function ownerFile(): string {
  return join(app.getPath('userData'), 'state.owner')
}

/**
 * Whether this instance is the one that saves the layout.
 *
 * state.json is a whole-window document — every tab, the split tree, the window
 * bounds — rewritten in full on a 500 ms debounce. Two windows both saving it
 * means the last one to quit wins and the other's tabs are simply gone, with
 * nothing said at the time. Merging them is not a coherent operation: there is
 * no sense in which two windows' tab lists combine into one window's layout.
 *
 * So the first instance to claim it saves, and later ones read the file and
 * leave it alone. That keeps the two-instances workflow the `lc` socket was
 * deliberately built for, while making the data loss impossible rather than
 * merely unlikely. The renderer asks for this so Mission Control can say so
 * out loud — a window that silently stopped remembering its tabs is worse than
 * one that says it is not remembering them.
 */
let owner: boolean | null = null

export function claimStateOwnership(): boolean {
  owner = claimOwnership(ownerFile())
  return owner
}

export function ownsState(): boolean {
  // Unclaimed means nothing called the claim yet — during tests, say. Saving is
  // the old behaviour, so that is what an unasked question defaults to.
  return owner ?? true
}

export function releaseStateOwnership(): void {
  if (owner) releaseOwnership(ownerFile())
  owner = null
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
  // Not ours to write: another window claimed it, and overwriting would throw
  // away its tabs. The renderer keeps working; only the remembering stops.
  if (!ownsState()) return
  if (!atomicWrite(stateFile(), JSON.stringify(state, null, 2))) {
    console.error('saveState failed')
  }
}
