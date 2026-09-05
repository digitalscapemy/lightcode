import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs'

/**
 * What one running Light Code may assume about the others.
 *
 * Two instances are a supported way to work — the `lc` socket was deliberately
 * made pid-keyed rather than taking the workflow away with a single-instance
 * lock. But "supported" only held for the socket. Everything else under
 * userData was written as though this process were the only one: a shared hook
 * spool that each launch purges, a whole-document state.json every window
 * rewrites, and settings files truncated in place while another instance's
 * agent is reading them.
 *
 * This module is the small set of primitives that makes the rest of it as
 * careful as the socket already was: is that pid still alive, write this file
 * without ever exposing a half-written version, and who owns the files only one
 * instance may own.
 */

/**
 * True unless the process is provably gone.
 *
 * The distinction that matters is ESRCH versus everything else. EPERM is a live
 * process owned by another user — answering "dead" there is how you delete a
 * running instance's files. So anything other than ESRCH is treated as alive,
 * and the cost of being wrong is a stale file nobody looks at rather than a
 * window losing its work.
 */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

/**
 * The pid a `<prefix><pid>` directory or file name belongs to, or null.
 *
 * Strict on purpose, for the same reason `socketOwnerPid` is: callers delete
 * whatever this returns a pid for, and a loose match is how a sweep reaches
 * something it did not write.
 */
export function ownerPid(name: string, prefix = ''): number | null {
  if (!name.startsWith(prefix)) return null
  const digits = name.slice(prefix.length)
  if (!/^[1-9][0-9]*$/.test(digits)) return null
  return Number(digits)
}

/**
 * Write a file so no reader can ever see it partly written.
 *
 * Temporary beside the target, then rename — a same-directory rename is atomic,
 * so a concurrent reader gets either the whole old file or the whole new one.
 * The temporary carries our pid so two instances writing at once cannot land on
 * the same scratch name and hand each other's bytes over.
 *
 * Returns false rather than throwing: every caller here has something sensible
 * to do without the write, and none of them should take the app down.
 */
export function atomicWrite(file: string, data: string): boolean {
  const tmp = `${file}.${process.pid}.tmp`
  try {
    writeFileSync(tmp, data, 'utf8')
    renameSync(tmp, file)
    return true
  } catch {
    try {
      unlinkSync(tmp)
    } catch {
      // nothing to clean up
    }
    return false
  }
}

/**
 * Claim a file only one instance may write, and say whether we got it.
 *
 * Used for state.json, which is a whole-window document — tabs, layout, window
 * bounds. Two instances saving it means last-quit-wins and the other window's
 * tabs are simply gone. Merging two windows' tab lists is not a thing that
 * means anything, so the answer is ownership rather than merging: the first
 * instance saves, later ones read the file and leave it alone.
 *
 * A claim by a dead pid is taken over, so a crash costs nothing beyond the next
 * launch. A claim by a live pid is honoured even if that instance is idle,
 * because "idle" is not a state we can see and being wrong loses tabs.
 */
export function claimOwnership(file: string): boolean {
  try {
    if (existsSync(file)) {
      const pid = ownerPid(readFileSync(file, 'utf8').trim())
      if (pid !== null && pid !== process.pid && isPidAlive(pid)) return false
    }
  } catch {
    // unreadable claim: treat it as nobody's and overwrite below
  }
  return atomicWrite(file, String(process.pid))
}

/** Give up a claim, but only if it is still ours. */
export function releaseOwnership(file: string): void {
  try {
    if (ownerPid(readFileSync(file, 'utf8').trim()) !== process.pid) return
    unlinkSync(file)
  } catch {
    // never claimed, already gone, or someone else's — all fine
  }
}
