import { closePane, contextWindowFor, markDrivenByLc, panes } from './app'
import { runFanOut } from './fanOutUi'
import { AGENT_COUNTS } from './fanOut'
import type { AgentCount } from './fanOut'
import { expectingAgent, paneStatus, paneUsage, state } from './store'
import { paneNodes } from './splitTree'
import { LC_PROTOCOL } from '../../shared/lc'
import type { LcPane, LcRequest, LcResponse } from '../../shared/lc'
import type { PaneStatus } from '../../shared/ipc'

/**
 * Answering `lc`.
 *
 * Main owns the socket; every actual answer is here, because this is the side
 * that knows what a pane is doing. Nothing in this file computes anything new —
 * the status, the token counts, the branches and the scrollback are all already
 * on screen, and this hands the same values out in text.
 */

const STATUS_WORD: Record<PaneStatus, string> = {
  working: 'working',
  'waiting-input': 'waiting',
  'waiting-approval': 'approval',
  idle: 'idle'
}

/**
 * Spelled out rather than derived from LcResponse. An Omit over that union
 * collapses to something that accepts any object at all, which let a command
 * return the wrong shape and typecheck clean — a helper that defeats the type
 * checker is worse than no helper.
 */
type LcPayload =
  | { panes: LcPane[] }
  | { lines: string[] }
  | { done: { pane: string; state: string }[] }
  | { created: { pane: string; branch: string }[] }
  | Record<string, never>

function ok(payload: LcPayload): LcResponse {
  return { ok: true, protocol: LC_PROTOCOL, ...payload } as LcResponse
}

function no(error: string): LcResponse {
  return { ok: false, protocol: LC_PROTOCOL, error }
}

/** The pane a request names, or null with a message the caller can act on. */
function findPane(id: string): { tabName: string; cwd: string } | null {
  for (const tab of state.tabs) {
    const node = paneNodes(tab.layout).find((p) => p.id === id)
    if (node) return { tabName: tab.name, cwd: node.cwd ?? tab.projectPath }
  }
  return null
}

function describe(from: string | undefined): LcPane[] {
  const out: LcPane[] = []
  for (const tab of state.tabs) {
    for (const node of paneNodes(tab.layout)) {
      const pane = panes.get(node.id)
      const status = paneStatus.get(node.id)
      const usage = paneUsage.get(node.id) ?? null
      const git = pane?.gitSnapshot() ?? null
      out.push({
        pane: node.id,
        tab: tab.name,
        status: status ? STATUS_WORD[status.status] : 'idle',
        tool: status?.lastTool ?? null,
        contextTokens: usage?.contextTokens ?? 0,
        contextWindow: contextWindowFor(usage?.model ?? null),
        cwd: node.cwd ?? tab.projectPath,
        branch: git?.branch ?? null,
        worktree: git?.worktree ?? false,
        role: node.role?.id ?? null,
        self: node.id === from
      })
    }
  }
  return out
}

/**
 * Wait for panes to reach a state.
 *
 * `idle` means an agent's turn ended, and leans on the hooks rather than on
 * silence — the pane genuinely knows. It therefore only answers for panes
 * running an agent: a shell running `npm test` has no turn to end, and waiting
 * on one would hang for the whole timeout and then lie about why. Those panes
 * are refused up front, which is a worse answer to receive and a much better
 * one to receive quickly.
 *
 * `exit` is the shell process itself ending, which is what a pane closing looks
 * like from outside.
 *
 * Panes already in the target state return at once, so a caller that races the
 * app does not wait for a transition that has been and gone.
 */
function waitFor(ids: string[], target: 'idle' | 'exit', timeoutMs: number): Promise<LcResponse> {
  const missing = ids.filter((id) => !panes.has(id))
  if (missing.length > 0) return Promise.resolve(no(`No such pane: ${missing.join(', ')}`))

  if (target === 'idle') {
    // A pane a fan-out has just queued `claude` into has no status yet but is
    // about to; refusing it here broke the documented fan-then-wait sequence for
    // anyone quick enough to run the two back to back. Only a pane with neither
    // a status nor an expectation genuinely has no turn coming.
    const agentless = ids.filter((id) => !paneStatus.has(id) && !expectingAgent.has(id))
    if (agentless.length > 0) {
      return Promise.resolve(
        no(
          `No agent is running in ${agentless.join(', ')}, so there is no turn to wait for. ` +
            'Use --for exit to wait for the shell to end, or start an agent first.'
        )
      )
    }
  }

  const reached = (id: string): boolean => {
    if (target === 'exit') return panes.get(id)?.exited === true
    const s = paneStatus.get(id)?.status
    if (s === undefined) return false // expected but not started: keep waiting
    if (s === 'idle' && expectingAgent.has(id)) return false // the agent we asked
    // for has not reported yet, and `idle` here means "nothing bound", not "done"
    return s === 'waiting-input' || s === 'idle'
  }

  return new Promise((resolve) => {
    const settle = (timedOut: boolean): void => {
      window.clearInterval(timer)
      window.clearTimeout(deadline)
      if (timedOut) {
        const late = ids.filter((id) => !reached(id))
        resolve(no(`Timed out after ${timeoutMs}ms waiting for ${late.join(', ')}`))
        return
      }
      resolve(
        ok({
          done: ids.map((id) => ({
            pane: id,
            state: target === 'exit' ? 'exited' : (STATUS_WORD[paneStatus.get(id)?.status ?? 'idle'])
          }))
        })
      )
    }
    // Polled rather than subscribed: status arrives through several routes
    // (hooks, transcript, pty exit) and a poll cannot miss one of them.
    const timer = window.setInterval(() => {
      if (ids.every(reached)) settle(false)
    }, 250)
    const deadline = window.setTimeout(() => settle(true), timeoutMs)
    if (ids.every(reached)) settle(false)
  })
}

export async function handleLcRequest(req: LcRequest): Promise<LcResponse> {
  if (req.cmd === 'ls') return ok({ panes: describe(req.from) })

  if (req.cmd === 'read') {
    const pane = panes.get(req.pane)
    if (!pane) return no(`No such pane: ${req.pane}. Try: lc ls`)
    return ok({ lines: pane.recentLines(Math.max(1, Math.min(req.tail, 2000))) })
  }

  if (req.cmd === 'send') {
    const pane = panes.get(req.pane)
    if (!pane) return no(`No such pane: ${req.pane}. Try: lc ls`)
    // Exactly the path a keystroke takes. The terminal cannot tell the
    // difference, which is the point — and why the pane is marked.
    window.lightclaude.pty.write(req.pane, req.enter ? `${req.text}\r` : req.text)
    markDrivenByLc(req.pane)
    return ok({})
  }

  if (req.cmd === 'close') {
    if (!panes.has(req.pane)) return no(`No such pane: ${req.pane}`)
    // Deliberately closePane, not the flow that offers to remove worktrees:
    // discarding a checkout is a decision for a person looking at it, not
    // something an agent should be able to ask for down a socket.
    closePane(req.pane)
    return ok({})
  }

  if (req.cmd === 'wait') {
    return waitFor(req.panes, req.for, Math.max(1000, Math.min(req.timeoutMs, 15 * 60_000)))
  }

  if (req.cmd === 'fan') {
    const count = req.count as AgentCount
    if (!AGENT_COUNTS.includes(count)) {
      return no(`count must be one of ${AGENT_COUNTS.join(', ')}`)
    }
    // The caller's own pane decides the repository. Falling back to the focused
    // pane — which is wherever the human last clicked — meant an agent fanning
    // out while its user looked at another project branched the wrong one.
    const caller = req.from ? findPane(req.from) : null
    if (req.from && !caller) return no(`No such pane: ${req.from}`)
    const here = caller ?? (state.focusedPaneId ? findPane(state.focusedPaneId) : null)
    const cwd = here?.cwd ?? state.tabs[0]?.projectPath
    if (!cwd) return no('No pane to branch from.')
    const created = await runFanOut(cwd, {
      task: req.task,
      count,
      prompt: req.prompt,
      plan: req.plan
    })
    if (created === null) return no('Fan-out failed — see the app for the reason.')
    return ok({ created })
  }

  return no('Unknown command.')
}

/** Subscribe once, at boot. */
export function initLc(): void {
  window.lightclaude.lc.onRequest((id, req) => {
    void handleLcRequest(req)
      .catch((err: unknown) => no(err instanceof Error ? err.message : String(err)))
      .then((res) => window.lightclaude.lc.reply(id, res))
  })
}
