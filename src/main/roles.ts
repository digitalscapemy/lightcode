import { readFile } from 'fs/promises'
import { join } from 'path'
import { BUILTIN_ROLES, ROLES_OVERRIDE, mergeRoles } from '../shared/roles'
import type { RolesResult } from '../shared/roles'
import { gitInfo } from './git'

/**
 * Where a squad's roles come from: the five built in, unless the repository
 * says otherwise.
 *
 * The override lives in the repository rather than in app settings on purpose.
 * A squad is a property of the project — a Rails app and an embedded firmware
 * tree do not want the same five terminals — and putting it in the repo means
 * it is versioned, reviewed and shared with everyone who clones it, none of
 * which is true of a JSON blob in userData.
 *
 * A file that cannot be read at all is not an error: most repositories will
 * never have one. A file that exists but cannot be *used* is, and it is
 * reported rather than silently ignored — a squad quietly missing the role you
 * wrote is worse than one that tells you your file was skipped.
 */
export async function loadRoles(cwd: string): Promise<RolesResult> {
  const info = await gitInfo(cwd)
  // Read from the repository, not the pane's directory. A pane sitting in a
  // worktree or three levels down in src/ is still working on the same project,
  // and the roles are the project's.
  const root = info.mainRoot
  if (root === null) return { roles: BUILTIN_ROLES, error: null }

  let text: string
  try {
    text = await readFile(join(root, ...ROLES_OVERRIDE.split('/')), 'utf8')
  } catch {
    return { roles: BUILTIN_ROLES, error: null } // no override: the common case
  }

  let parsed: unknown
  try {
    // The BOM an editor may have left would otherwise make JSON.parse fail on
    // character 0, which tells the author nothing about their file.
    parsed = JSON.parse(text.replace(/^﻿/, ''))
  } catch (err) {
    return {
      roles: BUILTIN_ROLES,
      error: `${ROLES_OVERRIDE} is not valid JSON: ${(err as Error).message}`
    }
  }
  return mergeRoles(BUILTIN_ROLES, parsed)
}
