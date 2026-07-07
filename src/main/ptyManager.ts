import { ipcMain } from 'electron'
import type { WebContents } from 'electron'
import * as pty from 'node-pty'
import { existsSync } from 'fs'
import { homedir } from 'os'
import { IPC } from '../shared/ipc'
import type { SpawnOptions, SpawnResult } from '../shared/ipc'
import { detectShell } from './shell'
import type { UsageWatcher } from './usageWatcher'

/** OSC 9;9;<cwd> BEL|ST — emitted by the prompt hook injected in shell.ts. */
const CWD_OSC = /\x1b\]9;9;("?)([^\x07\x1b]*)\1(?:\x07|\x1b\\)/g

export class PtyManager {
  private ptys = new Map<string, pty.IPty>()
  private carries = new Map<string, string>() // partial OSC split across chunks
  private target: WebContents | null = null

  constructor(private usage: UsageWatcher) {}

  setTarget(wc: WebContents): void {
    this.target = wc
  }

  register(): void {
    ipcMain.handle(IPC.PtySpawn, (_e, opts: SpawnOptions): SpawnResult => this.spawn(opts))
    // Hot paths use fire-and-forget channels to avoid promise round-trips.
    ipcMain.on(IPC.PtyWrite, (_e, paneId: string, data: string) => {
      this.usage.noteInput(paneId) // feeds session→pane attribution
      this.ptys.get(paneId)?.write(data)
    })
    ipcMain.on(IPC.PtyResize, (_e, paneId: string, cols: number, rows: number) => {
      try {
        this.ptys.get(paneId)?.resize(Math.max(2, cols), Math.max(1, rows))
      } catch {
        // resize can throw if the process is mid-exit
      }
    })
    ipcMain.on(IPC.PtyKill, (_e, paneId: string) => this.kill(paneId))
  }

  spawn({ paneId, cwd, cols, rows }: SpawnOptions): SpawnResult {
    this.kill(paneId)
    const shell = detectShell()

    let realCwd = cwd
    let cwdFallback = false
    if (!cwd || !existsSync(cwd)) {
      realCwd = homedir()
      cwdFallback = true
    }

    const proc = pty.spawn(shell.file, shell.args, {
      name: 'xterm-256color',
      cwd: realCwd,
      cols: Math.max(2, cols),
      rows: Math.max(1, rows),
      ...(process.platform === 'win32' ? { useConpty: true } : {}),
      env: { ...(process.env as Record<string, string>), ...shell.env }
    })
    this.ptys.set(paneId, proc)
    this.usage.bindPane(paneId, realCwd)

    proc.onData((data) => {
      this.send(IPC.PtyData, paneId, data)
      this.trackCwd(paneId, data)
    })
    proc.onExit(({ exitCode }) => {
      // Only forward exits for panes we still own (not explicit kills).
      if (this.ptys.get(paneId) === proc) {
        this.ptys.delete(paneId)
        this.carries.delete(paneId)
        this.usage.unbindPane(paneId)
        this.send(IPC.PtyExit, paneId, exitCode)
      }
    })

    return { shell: shell.file, cwd: realCwd, cwdFallback }
  }

  /** Follow the pane's live cwd from the OSC 9;9 the prompt hook emits. */
  private trackCwd(paneId: string, data: string): void {
    const text = (this.carries.get(paneId) ?? '') + data
    let cwd: string | null = null
    let lastEnd = 0
    CWD_OSC.lastIndex = 0
    for (let m = CWD_OSC.exec(text); m; m = CWD_OSC.exec(text)) {
      cwd = m[2]
      lastEnd = CWD_OSC.lastIndex
    }
    if (cwd) {
      this.usage.bindPane(paneId, cwd)
      this.send(IPC.PtyCwd, paneId, cwd) // renderer persists it for respawn
    }
    // Keep a short tail in case a sequence is split across data chunks.
    this.carries.set(paneId, text.slice(Math.max(lastEnd, text.length - 256)))
  }

  kill(paneId: string): void {
    const proc = this.ptys.get(paneId)
    if (!proc) return
    this.ptys.delete(paneId)
    this.carries.delete(paneId)
    this.usage.unbindPane(paneId)
    try {
      proc.kill()
    } catch {
      // already dead
    }
  }

  killAll(): void {
    for (const id of [...this.ptys.keys()]) this.kill(id)
  }

  private send(channel: string, ...args: unknown[]): void {
    if (this.target && !this.target.isDestroyed()) {
      this.target.send(channel, ...args)
    }
  }
}
