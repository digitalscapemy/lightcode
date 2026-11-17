import { crewEvent, markDrivenByLc, panes } from './app'
import { firstWords } from './crewEvents'
import { crewSignal } from './crewStrip'
import { approvalKeystroke, interruptKeystroke, sendGate, sendKeystrokes } from './lcPolicy'
import { lastSent, paneStatus, state } from './store'
import { paneNodes } from './splitTree'
import type { LcErrorKind } from '../../shared/lc'
import type { PaneNode } from '../../shared/types'

/**
 * Steering a pane from outside it: one path for the agent CLI and the buttons.
 *
 * `lc send` from a lead and the send box on a worker card do the same thing to
 * the same pane, and they must not grow two answers to "is this safe". Both
 * come through here, so the send gate, the paste handling and the record of
 * what was sent are the same whichever hand is on it. What is allowed is
 * decided in lcPolicy; this only acts on the answer.
 */

export type SteerAction =
  | { kind: 'send'; text: string; enter: boolean; force?: boolean }
  | { kind: 'approve' }
  | { kind: 'deny' }
  | { kind: 'interrupt' }

export interface SteerBy {
  /** `lc` (an agent), or a person at a card or a shortcut. */
  via: 'lc' | 'human'
  /** The calling pane, for `lc`. The self-send rule needs it. */
  from?: string
  /** canDrive's warning, when an `lc` caller was outside the pane's crew. */
  offScope?: string
}

export type SteerResult = { ok: true; warning?: string } | { ok: false; error: string; kind: LcErrorKind }

function nodeOf(paneId: string | undefined): PaneNode | undefined {
  if (paneId === undefined) return undefined
  for (const tab of state.tabs) {
    const node = paneNodes(tab.layout).find((n) => n.id === paneId)
    if (node) return node
  }
  return undefined
}

function agentOf(paneId: string): string | null {
  return nodeOf(paneId)?.agent ?? null
}

/** Who a card says sent a message: a person, a handle, or a bare pane id. */
function senderLabel(by: SteerBy): string {
  if (by.via === 'human') return 'you'
  if (by.from === undefined) return 'lc'
  const crew = nodeOf(by.from)?.crew
  return crew ? `@${crew.handle}` : by.from
}

/** Writes made in order, each after its own delay, stopping if the pane goes. */
async function typeInto(paneId: string, text: string, enter: boolean): Promise<void> {
  const pane = panes.get(paneId)
  if (!pane) return
  for (const k of sendKeystrokes(text, enter, pane.acceptsBracketedPaste())) {
    if (k.delayMs > 0) await new Promise((r) => window.setTimeout(r, k.delayMs))
    if (!panes.has(paneId)) return
    window.lightclaude.pty.write(paneId, k.data)
  }
}

export async function steer(paneId: string, action: SteerAction, by: SteerBy): Promise<SteerResult> {
  const pane = panes.get(paneId)
  if (!pane) return { ok: false, error: `No such pane: ${paneId}. Try: lc ls`, kind: 'usage' }
  if (pane.exited) {
    return { ok: false, error: `${paneId} has exited; there is nothing to type into.`, kind: 'refused' }
  }

  if (action.kind === 'send') {
    const gate = sendGate({
      target: paneId,
      from: by.from,
      status: paneStatus.get(paneId)?.status,
      force: action.force === true,
      source: paneStatus.get(paneId)?.source,
      text: action.text,
      byAgent: by.via === 'lc'
    })
    if (!gate.allow) return { ok: false, error: gate.error, kind: 'refused' }
    // Exactly the path a keystroke takes. The terminal cannot tell the
    // difference, which is the point — and why a pane `lc` drove is marked.
    await typeInto(paneId, action.text, action.enter)
    // For the worker card. Only a crew member has one, so a plain pane leaves
    // no trace here — see store.lastSent.
    if (nodeOf(paneId)?.crew) {
      lastSent.set(paneId, { text: action.text, at: Date.now(), by: senderLabel(by) })
    }
    if (by.via === 'lc') markDrivenByLc(paneId, by.offScope)
    crewEvent(paneId, 'sent', { by: senderLabel(by), detail: firstWords(action.text) })
    crewSignal(paneId)
    return gate.warning ? { ok: true, warning: gate.warning } : { ok: true }
  }

  if (action.kind === 'interrupt') {
    window.lightclaude.pty.write(paneId, interruptKeystroke(agentOf(paneId)))
    if (by.via === 'lc') markDrivenByLc(paneId, by.offScope)
    crewEvent(paneId, 'interrupted', { by: senderLabel(by) })
    crewSignal(paneId)
    return { ok: true }
  }

  // Approve and deny read the status now, at the moment of writing, rather than
  // trusting whatever drew the button: see lcPolicy.approvalKeystroke.
  const key = approvalKeystroke({
    target: paneId,
    agent: agentOf(paneId),
    status: paneStatus.get(paneId)?.status,
    source: paneStatus.get(paneId)?.source,
    answer: action.kind === 'approve' ? 'yes' : 'no'
  })
  if (!key.allow) return { ok: false, error: key.error, kind: 'refused' }
  window.lightclaude.pty.write(paneId, key.data)
  if (by.via === 'lc') markDrivenByLc(paneId, by.offScope)
  const tool = paneStatus.get(paneId)?.lastTool
  crewEvent(paneId, action.kind === 'approve' ? 'approved' : 'denied', {
    by: senderLabel(by),
    ...(tool ? { detail: tool } : {})
  })
  crewSignal(paneId)
  return { ok: true }
}
