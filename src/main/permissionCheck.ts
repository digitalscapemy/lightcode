import { app } from 'electron'
import { execFile } from 'child_process'
import { existsSync, rmSync, statSync, unlinkSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import type { PermissionCheck } from '../shared/guides'
import { effectiveExecutionPolicy, loadShortcuts, profileTargets } from './shortcuts'

/**
 * Can Light Code do what its features need — above all, write the shortcuts
 * into $PROFILE? Each check tries the real thing in the gentlest way: a write
 * test drops a tiny temporary file and deletes it at once, and never creates or
 * changes anything the user has. Nothing here fixes a problem; each failed
 * check names the guide (shared/guides.ts) that walks the user through it.
 */

const IS_WIN = process.platform === 'win32'

/** Can a file be created in `dir`? Tries the nearest existing parent. */
export function canWriteIn(dir: string): { ok: boolean; reason?: string } {
  let target = dir
  // Test where the file would really go; for a folder not made yet, its parent.
  while (!existsSync(target)) {
    const up = dirname(target)
    if (up === target) return { ok: false, reason: 'no such folder' }
    target = up
  }
  const probe = join(target, `.lightcode-write-test-${process.pid}-${Date.now()}`)
  try {
    writeFileSync(probe, '')
    unlinkSync(probe)
    return { ok: true }
  } catch (err) {
    try {
      if (existsSync(probe)) rmSync(probe, { force: true })
    } catch {
      // nothing more to do
    }
    const code = (err as { code?: string })?.code
    return { ok: false, reason: code ?? (err instanceof Error ? err.message : String(err)) }
  }
}

/** Can an existing file be rewritten? Opens it for append without writing. */
export function canRewrite(file: string): { ok: boolean; reason?: string } {
  if (!existsSync(file)) return canWriteIn(dirname(file))
  try {
    const st = statSync(file)
    if (!st.isFile()) return { ok: false, reason: 'not a file' }
    // Opening for append (and writing nothing) asks the OS the real question.
    writeFileSync(file, '', { flag: 'a' })
    return { ok: true }
  } catch (err) {
    const code = (err as { code?: string })?.code
    return { ok: false, reason: code ?? 'not writable' }
  }
}

function gitVersion(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('git', ['--version'], { timeout: 5000, windowsHide: true, encoding: 'utf8' }, (err, out) => {
      resolve(err ? null : String(out).trim() || null)
    })
  })
}

export async function checkPermissions(): Promise<PermissionCheck[]> {
  const out: PermissionCheck[] = []

  if (IS_WIN) {
    const policy = effectiveExecutionPolicy()
    const blocked = policy !== null && /^(restricted|allsigned|undefined)$/i.test(policy)
    out.push({
      id: 'execution-policy',
      label: 'PowerShell loads $PROFILE',
      ok: !blocked,
      detail: policy === null ? 'Could not read the execution policy' : `Execution policy: ${blocked && /undefined/i.test(policy) ? 'Restricted' : policy}`,
      guide: blocked ? 'execution-policy' : undefined
    })
  }

  // Every profile file the shortcuts are written to.
  for (const file of profileTargets()) {
    const r = canRewrite(file)
    const blockedByWindows = IS_WIN && (r.reason === 'EPERM' || r.reason === 'EACCES')
    out.push({
      id: `profile:${file}`,
      label: `Write ${IS_WIN ? '$PROFILE' : file.replace(/^.*[\\/]/, '~/')}`,
      ok: r.ok,
      detail: r.ok ? file : `${file} (${r.reason})`,
      guide: blockedByWindows ? 'controlled-folder-access' : undefined
    })
  }

  const data = app.getPath('userData')
  const d = canWriteIn(data)
  out.push({
    id: 'app-data',
    label: 'Save settings and shortcuts',
    ok: d.ok,
    detail: d.ok ? data : `${data} (${d.reason})`
  })

  const root = loadShortcuts().projectRoot
  if (root) {
    const r = canWriteIn(root)
    out.push({
      id: 'project-root',
      label: 'Create projects in the main folder',
      ok: r.ok,
      detail: r.ok ? root : `${root} (${r.reason})`,
      guide: IS_WIN && (r.reason === 'EPERM' || r.reason === 'EACCES') ? 'controlled-folder-access' : undefined
    })
  }

  const git = await gitVersion()
  out.push({
    id: 'git',
    label: 'Git (for worktrees and Fan-out)',
    ok: git !== null,
    detail: git ?? 'git was not found on PATH',
    guide: git === null ? 'git-missing' : undefined
  })

  return out
}
