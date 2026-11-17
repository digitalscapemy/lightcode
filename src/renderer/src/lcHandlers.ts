import { closePane, conduct, contextWindowFor, crewEvent, openWorker, panes } from './app'
import { STATUS_WORD, crewEvents, firstWords } from './crewEvents'
import { createWorktreesSerially, runFanOut } from './fanOutUi'
import { AGENT_COUNTS, quotePrompt } from './fanOut'
import type { AgentCount } from './fanOut'
import {
  SEND_EXPECT_MS,
  SPAWN_BRANCH_TRIES,
  SPAWN_WINDOW_MS,
  approveGate,
  cleanLines,
  pauseGate,
  sendExpectsReply,
  spawnBranch,
  spawnGate,
  waitState
} from './lcPolicy'
import type { Gate, WaitState } from './lcPolicy'
import { steer } from './steer'
import type { SteerBy } from './steer'
import {
  expectingAgent,
  newId,
  notifyStatus,
  paneStatus,
  paneUsage,
  state,
  statusListeners
} from './store'
import { paneNodes } from './splitTree'
import { AGENTS, AGENT_IDS, DEFAULT_AGENT } from '../../shared/agents'
import type { AgentAdapter } from '../../shared/agents'
import { canDrive, crewMembers, handleError, nextHandle, resolveTarget } from '../../shared/crew'
import type { CrewEvent, CrewPane } from '../../shared/crew'
import { LC_PROTOCOL, LC_SPLIT } from '../../shared/lc'
import type {
  LcErrorKind,
  LcPane,
  LcRequest,
  LcResponse,
  LcResult,
  LcSpawned,
  LcWaitFor
} from '../../shared/lc'
import type { StatusUpdate } from '../../shared/ipc'
import { roleById, rolePrompt } from '../../shared/roles'
import type { PaneNode, PaneNodeRole } from '../../shared/types'

/**
 * Answering `lc`.
 *
 * Main owns the socket; every actual answer is here, because this is the side
 * that knows what a pane is doing. Nothing in this file computes anything new —
 * the status, the token counts, the branches and the scrollback are all already
 * on screen, and this hands the same values out in text. What is allowed is
 * decided in lcPolicy, so the rules can be read and tested on their own.
 */

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
  | { spawned: LcSpawned }
  | { result: LcResult }
  | { events: CrewEvent[]; seq: number }
  | Record<string, never>

function ok(payload: LcPayload, warning?: string): LcResponse {
  return {
    ok: true,
    protocol: LC_PROTOCOL,
    ...payload,
    ...(warning ? { warning } : {})
  } as LcResponse
}

function no(error: string, kind: LcErrorKind): LcResponse {
  return { ok: false, protocol: LC_PROTOCOL, error, kind }
}

/** Every pane node in the window, in reading order, tab by tab. */
function allNodes(): PaneNode[] {
  return state.tabs.flatMap((tab) => paneNodes(tab.layout))
}

function nodeOf(id: string | undefined): PaneNode | undefined {
  return id === undefined ? undefined : allNodes().find((n) => n.id === id)
}

/**
 * Swap every `@name` in a request for the pane it means, before anything else
 * reads it. A pane id passes straight through, so a request that names panes
 * the old way is the same request afterwards. See crew.resolveTarget.
 *
 * Commands that act on one pane refuse a name that means several; `wait` takes
 * as many as it is given.
 */
function resolveTargets(req: LcRequest): { req: LcRequest } | { res: LcResponse } {
  const all: CrewPane[] = allNodes().map((n) => ({
    pane: n.id,
    ...(n.crew ? { crew: n.crew } : {}),
    role: n.role?.id ?? null
  }))
  const one = (target: string): string | { res: LcResponse } => {
    const r = resolveTarget(target, req.from, all)
    if ('error' in r) return { res: no(r.error, 'usage') }
    if (r.panes.length > 1) {
      const error =
        `${target} means ${r.panes.length} panes (${r.panes.join(', ')}); ` +
        `${req.cmd} takes one. Name it by handle or pane id.`
      return { res: no(error, 'usage') }
    }
    return r.panes[0]!
  }
  if (
    req.cmd === 'read' ||
    req.cmd === 'send' ||
    req.cmd === 'close' ||
    req.cmd === 'ask' ||
    req.cmd === 'result' ||
    req.cmd === 'approve' ||
    req.cmd === 'interrupt'
  ) {
    const pane = one(req.pane)
    return typeof pane === 'string' ? { req: { ...req, pane } } : pane
  }
  if (req.cmd === 'wait') {
    const out: string[] = []
    for (const target of req.panes) {
      const r = resolveTarget(target, req.from, all)
      if ('error' in r) return { res: no(r.error, 'usage') }
      for (const id of r.panes) if (!out.includes(id)) out.push(id)
    }
    return { req: { ...req, panes: out } }
  }
  return { req }
}

/**
 * Whether the caller may drive this pane, judged by crew. Warn, never block,
 * unless a crew involved is strict — see crew.canDrive.
 */
function driveCheck(req: LcRequest, target: string): ReturnType<typeof canDrive> {
  const fromCrew = nodeOf(req.from)?.crew
  const targetCrew = nodeOf(target)?.crew
  const strictOf = (id: string | undefined): boolean =>
    id !== undefined && state.crewSettings[id]?.strict === true
  return canDrive({
    from: req.from,
    fromCrew,
    target,
    targetCrew,
    strict: strictOf(fromCrew?.id) || strictOf(targetCrew?.id),
    unverified: req.unverified === true
  })
}

/**
 * Whether an agent may act on this pane at all right now: not while either
 * crew is paused (lcPolicy.pauseGate), and then by crew (driveCheck). Only for
 * commands that change something — looking is always allowed.
 */
function mayAct(req: LcRequest, target: string): Gate {
  const pause = pauseGate({
    fromCrew: nodeOf(req.from)?.crew,
    targetCrew: nodeOf(target)?.crew,
    settings: state.crewSettings
  })
  if (!pause.allow) return pause
  return driveCheck(req, target)
}

/** Two warnings, or one, or none — never an empty string. */
function joinWarnings(...parts: (string | undefined)[]): string | undefined {
  const text = parts.filter((p): p is string => !!p).join(' ')
  return text === '' ? undefined : text
}

/** The pane a request names, or null with a message the caller can act on. */
function findPane(id: string): { tabName: string; cwd: string } | null {
  for (const tab of state.tabs) {
    const node = paneNodes(tab.layout).find((p) => p.id === id)
    if (node) return { tabName: tab.name, cwd: node.cwd ?? tab.projectPath }
  }
  return null
}

/**
 * Every pane, as `lc ls` reports it. `crew` narrows it to the caller's crew —
 * or, for a caller in none, to every pane that is in one.
 */
function describe(from: string | undefined, crew = false): LcPane[] {
  const out: LcPane[] = []
  const own = nodeOf(from)?.crew?.id
  for (const tab of state.tabs) {
    for (const node of paneNodes(tab.layout)) {
      if (crew && (node.crew === undefined || (own !== undefined && node.crew.id !== own))) continue
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
        self: node.id === from,
        // Only on a pane that has them, so a window without crews lists every
        // pane exactly as it always did — no new keys, no columns of dashes.
        ...(node.crew
          ? {
              crew: node.crew.id,
              handle: node.crew.handle,
              ...(node.crew.lead ? { lead: true as const } : {})
            }
          : {}),
        ...(node.agent ? { agent: node.agent } : {}),
        ...(status?.source === 'heuristic' ? { statusSource: 'heuristic' as const } : {})
      })
    }
  }
  return out
}

/**
 * Panes `lc send` typed a message into that nothing has picked up yet, and
 * the timers that give up on them.
 *
 * A send sets the same expectation a fan-out does — an agent is about to report
 * — so `lc wait --for idle` cannot return on the `waiting` left over from the
 * turn before. A fan-out's agent is still starting and gets as long as it needs;
 * a message to an agent that is already there should be picked up within
 * seconds, and if it is not, there is most likely nothing there to pick it up.
 * Then the expectation lapses and the pane lands in `unanswered`, which ends a
 * wait on it as `no-agent` rather than letting it sit out its whole timeout.
 *
 * It stays unanswered until the pane reports anything at all, and that is told
 * by the report itself: each one is a fresh object, so the one held here being
 * the one still in paneStatus means nothing has been heard since. Asking what
 * the status *is* would not do — the stale `waiting` from the turn before is
 * exactly what an unanswered pane is still showing.
 */
const unanswered = new Map<string, StatusUpdate | undefined>()
const sendExpiry = new Map<string, number>()

function isUnanswered(paneId: string): boolean {
  return unanswered.has(paneId) && unanswered.get(paneId) === paneStatus.get(paneId)
}

function expectReply(paneId: string): void {
  window.clearTimeout(sendExpiry.get(paneId))
  unanswered.delete(paneId)
  // An expectation somebody else set (a launch still starting) is theirs to
  // keep; timing it out here would cut a slow agent start short.
  if (expectingAgent.has(paneId) && !sendExpiry.has(paneId)) return
  expectingAgent.add(paneId)
  sendExpiry.set(
    paneId,
    window.setTimeout(() => {
      sendExpiry.delete(paneId)
      if (!panes.has(paneId) || !expectingAgent.has(paneId)) return
      expectingAgent.delete(paneId)
      unanswered.set(paneId, paneStatus.get(paneId))
      notifyStatus(paneId)
    }, SEND_EXPECT_MS)
  )
}

/** A closed pane takes its send bookkeeping with it. */
function forgetExpectation(paneId: string): void {
  if (panes.has(paneId)) return
  unanswered.delete(paneId)
  window.clearTimeout(sendExpiry.get(paneId))
  sendExpiry.delete(paneId)
}

/**
 * Type into a pane for an agent. The typing itself, and the gate in front of
 * it, are steer()'s — the same path a worker card's send box takes — so this
 * adds only what is `lc`'s own: the crew check and what `lc wait` expects.
 */
async function send(req: Extract<LcRequest, { cmd: 'send' }>): Promise<LcResponse> {
  if (!panes.has(req.pane)) return no(`No such pane: ${req.pane}. Try: lc ls`, 'usage')
  const status = paneStatus.get(req.pane)?.status
  const scope = mayAct(req, req.pane)
  if (!scope.allow) return no(scope.error, 'refused')
  // Forcing keystrokes into a crew worker's permission prompt answers it, so it
  // is held to exactly what lc approve is — otherwise --force would be a way
  // round the "Let lead approve worker tools" box. A plain pane keeps --force.
  const targetCrew = nodeOf(req.pane)?.crew
  if (status === 'waiting-approval' && req.force === true && targetCrew) {
    if (req.unverified === true) {
      return no('Forcing a send into a permission prompt needs the token the app put in your pane.', 'refused')
    }
    const gate = approveGate({
      from: req.from,
      fromCrew: nodeOf(req.from)?.crew,
      target: req.pane,
      targetCrew,
      settings: state.crewSettings[targetCrew.id]
    })
    if (!gate.allow) return no(gate.error, 'refused')
  }
  const res = await steer(
    req.pane,
    { kind: 'send', text: req.text, enter: req.enter, force: req.force === true },
    by(req, scope.warning)
  )
  if (!res.ok) return no(res.error, res.kind)
  if (sendExpectsReply({ enter: req.enter, status, expecting: expectingAgent.has(req.pane) }))
    expectReply(req.pane)
  return ok({}, joinWarnings(res.warning, scope.warning))
}

/** The word a settled pane is reported with in `done`. */
function settledWord(id: string, s: WaitState): string {
  if (s !== 'reached') return s
  if (panes.get(id)?.exited) return 'exited'
  return STATUS_WORD[paneStatus.get(id)?.status ?? 'idle']
}

const EARLY_WHY: Record<Exclude<WaitState, 'reached' | 'pending'>, string> = {
  gone: 'was closed',
  exited: 'exited',
  'no-agent': 'has no agent to take a turn (nothing picked up what was sent)'
}

/**
 * Wait for panes to reach a state.
 *
 * `idle` means an agent's turn ended, and leans on the hooks rather than on
 * silence — the pane genuinely knows. It therefore only answers for panes
 * running an agent: a shell running `npm test` has no turn to end, and waiting
 * on one would hang for the whole timeout and then lie about why. Those panes
 * are refused up front, which is a worse answer to receive and a much better
 * one to receive quickly. The same goes for `approval` and `working`.
 *
 * `exit` is the shell process itself ending, which is what a pane closing looks
 * like from outside. `any` is whichever comes first of a finished turn, a
 * permission prompt or the shell ending.
 *
 * Panes already in the target state return at once, so a caller that races the
 * app does not wait for a transition that has been and gone. A pane that can
 * no longer get there — closed, exited, or with nobody answering — ends the
 * wait too, with the reason in a warning, instead of holding the line open
 * until the timeout says something less useful.
 */
function waitFor(ids: string[], target: LcWaitFor, timeoutMs: number): Promise<LcResponse> {
  const missing = ids.filter((id) => !panes.has(id))
  if (missing.length > 0) return Promise.resolve(no(`No such pane: ${missing.join(', ')}`, 'usage'))

  if (target !== 'exit' && target !== 'any') {
    // A pane a fan-out has just queued `claude` into has no status yet but is
    // about to; refusing it here broke the documented fan-then-wait sequence for
    // anyone quick enough to run the two back to back. Only a pane with neither
    // a status nor an expectation genuinely has no turn coming.
    const agentless = ids.filter(
      (id) => !paneStatus.has(id) && !expectingAgent.has(id) && !panes.get(id)?.exited
    )
    if (agentless.length > 0) {
      return Promise.resolve(
        no(
          `No agent is running in ${agentless.join(', ')}, so there is no turn to wait for. ` +
            'Use --for exit to wait for the shell to end, or start an agent first.',
          'refused'
        )
      )
    }
  }

  const stateOf = (id: string): WaitState =>
    waitState(target, {
      exists: panes.has(id),
      exited: panes.get(id)?.exited === true,
      status: paneStatus.get(id)?.status,
      expecting: expectingAgent.has(id),
      unanswered: isUnanswered(id)
    })

  return new Promise((resolve) => {
    let settled = false
    const finish = (res: LcResponse): void => {
      settled = true
      statusListeners.delete(onChange)
      window.clearInterval(safety)
      window.clearTimeout(deadline)
      resolve(res)
    }
    const check = (): void => {
      if (settled) return
      const states = ids.map(stateOf)
      if (states.includes('pending')) return
      // A closed pane has, in every sense that matters, stopped: for `exit`
      // that is the answer and not an early one.
      const early = ids
        .map((id, i) => ({ id, s: states[i]! }))
        .filter(({ s }) => s !== 'reached' && !(target === 'exit' && s === 'gone'))
        .map(({ id, s }) => `${id} ${EARLY_WHY[s as keyof typeof EARLY_WHY]}`)
      finish(
        ok(
          { done: ids.map((id, i) => ({ pane: id, state: settledWord(id, states[i]!) })) },
          early.length > 0 ? `Stopped before reaching ${target}: ${early.join('; ')}.` : undefined
        )
      )
    }
    const onChange = (id: string): void => {
      if (ids.includes(id)) check()
    }
    statusListeners.add(onChange)
    // A net under the listeners, not the mechanism: see store.statusListeners.
    const safety = window.setInterval(check, 1000)
    const deadline = window.setTimeout(() => {
      if (settled) return
      const late = ids.filter((id) => stateOf(id) === 'pending')
      finish(no(`Timed out after ${timeoutMs}ms waiting for ${late.join(', ')}`, 'timeout'))
    }, timeoutMs)
    check()
  })
}

/** An `lc` caller as steer() takes it. */
function by(req: LcRequest, offScope: string | undefined): SteerBy {
  return {
    via: 'lc',
    ...(req.from !== undefined ? { from: req.from } : {}),
    ...(offScope ? { offScope } : {})
  }
}

/** Who a crew event says did something: a handle, or a bare pane id. */
function callerLabel(from: string | undefined): string {
  if (from === undefined) return 'lc'
  const crew = nodeOf(from)?.crew
  return crew ? `@${crew.handle}` : from
}

/** A folder path that means the same thing from any pane: absolute, either platform. */
function isAbsolutePath(p: string): boolean {
  return /^(?:[a-zA-Z]:[\\/]|[\\/])/.test(p)
}

/** Each caller's recent spawns (ms), for lcPolicy.spawnGate. */
const spawnHistory = new Map<string, number[]>()

/**
 * Spawns past the gate whose pane is not open yet: caller → the crew each one
 * will join. Counted against the crew's limit, because a lead's parallel Bash
 * calls arrive together and would otherwise all read the same worker count;
 * and a caller in no crew hands its first one's crew id to the rest, so they
 * all end up in the one orchestra that conduct() makes.
 */
const spawning = new Map<string, string[]>()

/** Drop the history of panes that are gone, and of spawns too old to count. */
function forgetOldSpawns(now: number): void {
  for (const [id, times] of spawnHistory) {
    const recent = times.filter((t) => now - t < SPAWN_WINDOW_MS)
    if (recent.length === 0 || !panes.has(id)) spawnHistory.delete(id)
    else spawnHistory.set(id, recent)
  }
}

/** Take back one entry a refused spawn had reserved. */
function removeOne<T>(map: Map<string, T[]>, key: string, value: T): void {
  const list = map.get(key)
  if (!list) return
  const i = list.indexOf(value)
  if (i !== -1) list.splice(i, 1)
  if (list.length === 0) map.delete(key)
}

/**
 * Open a worker beside the caller, in the caller's orchestra.
 *
 * Everything that can be refused is checked before anything is made — the
 * agent, the folder, the handle, the role, the limits — so a bad request
 * leaves no branch and no half-made crew behind. Only then is the caller made
 * a lead if it was conducting nothing (said in the warning, never silently),
 * the worktree created, and the pane split off without taking the keyboard.
 *
 * The limits are reserved before the first await and handed back if the spawn
 * is refused after it, so spawns arriving together cannot all slip under them.
 */
async function spawn(req: Extract<LcRequest, { cmd: 'spawn' }>): Promise<LcResponse> {
  const from = req.from
  if (from === undefined) {
    return no(
      'lc spawn opens the worker beside the pane asking, so it has to know which that is. ' +
        'Run it from a pane in the app.',
      'usage'
    )
  }
  const caller = nodeOf(from)
  const here = findPane(from)
  if (!caller || !here) return no(`No such pane: ${from}`, 'usage')

  const adapter = AGENTS[req.agent ?? DEFAULT_AGENT]
  if (!adapter) return no(`Unknown agent "${req.agent}". Known: ${AGENT_IDS.join(', ')}.`, 'usage')
  if (req.prompt !== null && adapter.launch(null, { plan: false, quote: (p) => p }) === '') {
    return no(
      `A ${adapter.label.toLowerCase()} worker starts nothing, so it takes no prompt. ` +
        'Spawn it without one, then `lc send` it a command.',
      'usage'
    )
  }
  if (req.cwd !== undefined && !isAbsolutePath(req.cwd)) {
    return no(`--cwd takes an absolute path; "${req.cwd}" would mean a different folder in every pane.`, 'usage')
  }
  if (req.split !== undefined && !LC_SPLIT.includes(req.split)) {
    return no(`--split takes ${LC_SPLIT.join(' or ')}.`, 'usage')
  }

  const pause = pauseGate({ fromCrew: caller.crew, targetCrew: undefined, settings: state.crewSettings })
  if (!pause.allow) return no(pause.error, 'refused')

  const crewId = caller.crew?.id
  // Minted now rather than by conduct(), so a squad folder can be named for it —
  // or borrowed from a spawn of this caller's still on its way.
  const newCrewId = crewId ?? spawning.get(from)?.[0] ?? newId('c')
  const members = crewId === undefined ? [] : crewMembers(allNodes(), crewId)
  const inFlight = [...spawning.values()].flat().filter((c) => c === newCrewId).length
  const now = Date.now()
  forgetOldSpawns(now)
  const recent = spawnHistory.get(from) ?? []
  const limit = spawnGate({
    recent,
    now,
    workers: members.filter((n) => !n.crew!.lead).length + inFlight
  })
  if (!limit.allow) return no(limit.error, 'refused')
  spawnHistory.set(from, [...recent, now])
  spawning.set(from, [...(spawning.get(from) ?? []), newCrewId])
  let opened = false
  try {
    const res = await spawnReserved(req, from, caller, here, adapter, newCrewId)
    opened = res.ok
    return res
  } finally {
    removeOne(spawning, from, newCrewId)
    if (!opened) removeOne(spawnHistory, from, now)
  }
}

/** The rest of spawn, once the limits are holding a place for it. */
async function spawnReserved(
  req: Extract<LcRequest, { cmd: 'spawn' }>,
  from: string,
  caller: PaneNode,
  here: { cwd: string },
  picked: AgentAdapter,
  newCrewId: string
): Promise<LcResponse> {
  let adapter = picked
  // A caller about to become a lead takes its handle first, so the new worker
  // cannot be handed the same one.
  const taken = (): string[] =>
    caller.crew
      ? crewMembers(allNodes(), caller.crew.id).map((n) => n.crew!.handle)
      : [nextHandle(caller.role?.id ?? 'lead', [], true)]
  let handle: string
  if (req.handle !== undefined) {
    const issue = handleError(req.handle, taken())
    if (issue !== null) return no(`--handle ${req.handle}: ${issue}`, 'usage')
    handle = req.handle
  } else {
    handle = nextHandle(req.role ?? (adapter.id === DEFAULT_AGENT ? 'worker' : adapter.id), taken())
  }

  let cwd = req.cwd ?? here.cwd
  let roleNode: PaneNodeRole | undefined
  let roleText: string | null = null
  // A role the squad starts in plan mode starts in it here too.
  let plan = req.plan
  if (req.role !== undefined) {
    const { roles } = await window.lightclaude.roles.list(cwd)
    const found = roleById(roles, req.role)
    if (!found) {
      return no(`No role "${req.role}" in this project. Known: ${roles.map((r) => r.id).join(', ')}.`, 'usage')
    }
    if (found.orchestrator === true) {
      return no(`"${found.id}" is the role that conducts; a worker takes one of the others.`, 'usage')
    }
    // The crew's squad folder when it has one, so every report lands together.
    const squadDir = caller.role?.squadDir ?? (await window.lightclaude.git.prepareSquad(cwd, newCrewId))
    if (squadDir === null) {
      return no(
        'A role reports into a squad folder beside the repository, and this folder is not in one.',
        'refused'
      )
    }
    roleNode = { id: found.id, squadDir }
    plan = plan || found.plan === true
    // The role's own agent, from roles.json, when --agent did not name one.
    if (req.agent === undefined && found.agent !== undefined && AGENTS[found.agent]) {
      adapter = AGENTS[found.agent]!
      if (req.prompt !== null && adapter.launch(null, { plan: false, quote: (p) => p }) === '') {
        return no(`The "${found.id}" role is played by a ${adapter.label.toLowerCase()}, which takes no prompt.`, 'usage')
      }
    }
    // An agent with no wrapper is told its role in its first message.
    if (adapter.rolePromptVia === 'first-message') roleText = rolePrompt(found)
  }

  let branch: string | undefined
  if (req.worktree === true || req.branch !== undefined) {
    // A --branch is tried as given. Without one the name is made up here, and
    // stepped past one a closed worker or another orchestra left behind.
    const names =
      req.branch !== undefined
        ? [req.branch]
        : Array.from({ length: SPAWN_BRANCH_TRIES }, (_, i) => spawnBranch(handle, newCrewId, i + 1))
    const problems: string[] = []
    for (const name of names) {
      const made = await createWorktreesSerially(cwd, [name], (message) => {
        problems.push(message)
      })
      if (made !== null && made[0] !== undefined) {
        branch = name
        cwd = made[0]
        break
      }
    }
    if (branch === undefined) {
      const last = problems[problems.length - 1]
      return no(`${last ?? `Could not create ${names[0]}.`} Name another with --branch.`, 'refused')
    }
  }

  // Everything above awaited: the caller may have been closed, or have joined
  // or left a crew, in the meantime.
  const current = nodeOf(from)
  if (!current) return no(`${from} was closed before the worker could be opened.`, 'refused')
  let warning: string | undefined
  let crew = current.crew
  if (!crew) {
    crew = conduct(from, newCrewId) ?? undefined
    if (!crew) return no(`Could not make ${from} a lead.`, 'refused')
    warning =
      `${from} was conducting no orchestra, so it now leads one (${crew.id}, as @${crew.handle}). ` +
      '"Stop Conducting" in its pane menu undoes that.'
  } else if (!crew.lead) {
    warning = `${from} is a worker, not its orchestra's lead; the new pane joins the crew under that lead.`
  }
  handle = nextHandle(
    handle,
    crewMembers(allNodes(), crew.id).map((n) => n.crew!.handle)
  )

  const isWindows = window.lightclaude.platform === 'win32'
  const command = adapter.launch(req.prompt, {
    plan,
    quote: (p) => quotePrompt(p, isWindows),
    rolePrompt: roleText
  })
  const pane = await openWorker({
    near: from,
    crewId: crew.id,
    handle,
    cwd,
    ...(command !== '' ? { command } : {}),
    node: { agent: adapter.id, ...(roleNode ? { role: roleNode } : {}) },
    ...(req.split ? { orientation: req.split === 'down' ? ('column' as const) : ('row' as const) } : {}),
    focus: false
  })
  if (pane === null) return no(`Could not open a pane beside ${from}.`, 'refused')
  // A turn is coming only when there is a prompt to take one — the task, or a
  // role told in the first message. An agent started empty waits to be told,
  // and `lc wait` on it should say so rather than hang.
  if (req.prompt !== null || (roleText !== null && command !== '')) expectingAgent.add(pane)
  crewEvent(pane, 'spawned', {
    by: callerLabel(from),
    ...(req.prompt ? { detail: firstWords(req.prompt) } : {})
  })
  return ok(
    { spawned: { pane, handle, crew: crew.id, cwd, agent: adapter.id, ...(branch ? { branch } : {}) } },
    warning
  )
}

/** Lines of screen a result falls back to, before cleaning. */
const RESULT_SCREEN_LINES = 120

/**
 * A pane's last answer: the agent's own final message from its transcript, or
 * failing that its screen, cleaned — with a warning saying which, because the
 * screen is the interface and not necessarily the answer.
 */
async function resultOf(paneId: string): Promise<{ result: LcResult; warning?: string }> {
  const busy =
    paneStatus.get(paneId)?.status === 'working'
      ? `${paneId} is mid-turn; this is the last answer it gave, not the one it is working on.`
      : undefined
  const text = await window.lightclaude.agent.result(paneId)
  if (text !== null) {
    return { result: { pane: paneId, text, source: 'transcript' }, ...(busy ? { warning: busy } : {}) }
  }
  const lines = cleanLines(panes.get(paneId)?.recentLines(RESULT_SCREEN_LINES) ?? [])
  const warning = joinWarnings(
    `${paneId} has no agent transcript to read, so this is its screen, cleaned — ` +
      'what it drew, which is not necessarily its answer.',
    busy
  )
  return {
    result: { pane: paneId, text: lines.join('\n'), source: 'screen' },
    ...(warning ? { warning } : {})
  }
}

/**
 * Send, wait for the turn to end, return the answer.
 *
 * A pane mid-turn is let finish first: typed into now, the question would sit
 * in its queue while the turn it is in ends, and the wait would come back with
 * the answer to whatever it was doing before. One deadline covers the lot.
 */
async function ask(req: Extract<LcRequest, { cmd: 'ask' }>): Promise<LcResponse> {
  const pane = req.pane
  if (!panes.has(pane)) return no(`No such pane: ${pane}. Try: lc ls`, 'usage')
  // The send gate refuses this too, but only after the wait below — and the
  // turn that wait is for is the one running this command, so it never ends.
  if (req.from === pane) {
    return no(`${pane} is your own pane — asking it would wait on the turn that asked.`, 'refused')
  }
  const scope = mayAct(req, pane)
  if (!scope.allow) return no(scope.error, 'refused')
  const deadline = Date.now() + Math.max(1000, Math.min(req.timeoutMs, 15 * 60_000))
  const left = (): number => Math.max(1000, deadline - Date.now())

  const status = paneStatus.get(pane)?.status
  if (
    status === undefined &&
    !expectingAgent.has(pane) &&
    !(await window.lightclaude.pty.claudeActive(pane))
  ) {
    return no(
      `No agent is running in ${pane}, so there is nobody to ask. ` +
        'Open one with lc spawn and give it the task as its prompt.',
      'refused'
    )
  }

  // The crew check's warning, if any, comes back with the send below.
  const warnings: (string | undefined)[] = []
  if (status === 'working' || (status === undefined && expectingAgent.has(pane))) {
    const first = await waitFor([pane], 'idle', left())
    if (!first.ok) return first
    if (first.warning) return no(`Nothing was asked: ${first.warning}`, 'refused')
    warnings.push(`${pane} was mid-turn; lc ask waited for that turn to end before asking.`)
  }

  // send() runs the same checks again, deliberately: the wait above may have
  // taken minutes, and a permission prompt may have appeared in that time.
  const sent = await send({
    cmd: 'send',
    pane,
    text: req.text,
    enter: true,
    ...(req.from !== undefined ? { from: req.from } : {}),
    ...(req.unverified ? { unverified: true as const } : {})
  })
  if (!sent.ok) return sent
  warnings.push(sent.warning)
  // Whatever send decided, this caller is about to wait for a reply, and a
  // message nobody picks up should end that wait in seconds, not at the deadline.
  if (!expectingAgent.has(pane)) expectReply(pane)

  const done = await waitFor([pane], 'idle', left())
  if (!done.ok) return done
  if (done.warning) return no(`No answer came back: ${done.warning}`, 'refused')
  const r = await resultOf(pane)
  return ok({ result: r.result }, joinWarnings(...warnings, r.warning))
}

/** How many past events a first `lc events`, with no --since, hands back. */
const EVENTS_BACKLOG = 50

/**
 * The caller's crew's events: what is there now, or — given `since` — the
 * next ones, held open until something happens. A caller in no crew sees every
 * crew's, and is told so.
 */
async function events(req: Extract<LcRequest, { cmd: 'events' }>): Promise<LcResponse> {
  const own = nodeOf(req.from)?.crew?.id
  const see = (e: CrewEvent): boolean => own === undefined || e.crew === own
  const scope =
    own === undefined ? 'This pane is in no orchestra, so events from every crew are listed.' : undefined
  const backlog = (warning?: string): LcResponse => {
    const page = crewEvents.since(0, see)
    return ok({ events: page.events.slice(-EVENTS_BACKLOG), seq: page.seq }, joinWarnings(warning, scope))
  }
  if (req.since === undefined) return backlog()
  // A seq from before the app last started means nothing to this log; waiting
  // for it to be passed would hold the line until long after it mattered.
  if (req.since > crewEvents.latest()) {
    return backlog(`#${req.since} is from before the app restarted; this is the stream as it stands.`)
  }
  const page = await crewEvents.wait(req.since, Math.max(1000, Math.min(req.timeoutMs, 15 * 60_000)), see)
  return ok(
    { events: page.events, seq: page.seq },
    joinWarnings(
      page.dropped > 0
        ? `${page.dropped} events after #${req.since} were dropped before you asked; ` +
            'lc ls --crew shows where everyone stands now.'
        : undefined,
      scope
    )
  )
}

/**
 * Answer a worker's permission prompt on the person's behalf. Off unless they
 * turned it on for this crew, and only ever from the crew's own lead — see
 * lcPolicy.approveGate. A caller that only claims to be the lead, with no token
 * to prove it, is refused: this is the one command where a forged `from` would
 * say yes to something for somebody else.
 */
async function approve(req: Extract<LcRequest, { cmd: 'approve' }>): Promise<LcResponse> {
  if (!panes.has(req.pane)) return no(`No such pane: ${req.pane}. Try: lc ls`, 'usage')
  if (req.answer !== 'yes' && req.answer !== 'no') return no('lc approve takes yes or no.', 'usage')
  const fromCrew = nodeOf(req.from)?.crew
  const targetCrew = nodeOf(req.pane)?.crew
  const pause = pauseGate({ fromCrew, targetCrew, settings: state.crewSettings })
  if (!pause.allow) return no(pause.error, 'refused')
  if (req.unverified === true) {
    return no('lc approve needs the token the app put in your pane, and this request came without one.', 'refused')
  }
  const gate = approveGate({
    from: req.from,
    fromCrew,
    target: req.pane,
    targetCrew,
    settings: targetCrew ? state.crewSettings[targetCrew.id] : undefined
  })
  if (!gate.allow) return no(gate.error, 'refused')
  const res = await steer(req.pane, { kind: req.answer === 'yes' ? 'approve' : 'deny' }, by(req, undefined))
  if (!res.ok) return no(res.error, res.kind)
  return ok({})
}

export async function handleLcRequest(raw: LcRequest): Promise<LcResponse> {
  const resolved = resolveTargets(raw)
  if ('res' in resolved) return resolved.res
  const req = resolved.req

  if (req.cmd === 'ls') {
    if (req.crew !== true) return ok({ panes: describe(req.from) })
    const listed = describe(req.from, true)
    const inCrew = nodeOf(req.from)?.crew !== undefined
    return ok(
      { panes: listed },
      inCrew
        ? undefined
        : listed.length === 0
          ? 'No pane in this window is in an orchestra.'
          : 'This pane is in no orchestra, so every crew is listed.'
    )
  }

  if (req.cmd === 'read') {
    const pane = panes.get(req.pane)
    if (!pane) return no(`No such pane: ${req.pane}. Try: lc ls`, 'usage')
    const tail = Math.max(1, Math.min(req.tail, 2000))
    if (req.clean !== true) return ok({ lines: pane.recentLines(tail) })
    // Read deeper than asked: cleaning drops most of a TUI's rows, and the
    // caller asked for N lines of words, not N rows of which a few are words.
    return ok({ lines: cleanLines(pane.recentLines(Math.min(tail * 3, 2000))).slice(-tail) })
  }

  if (req.cmd === 'spawn') return spawn(req)
  if (req.cmd === 'ask') return ask(req)
  if (req.cmd === 'events') return events(req)

  if (req.cmd === 'result') {
    if (!panes.has(req.pane)) return no(`No such pane: ${req.pane}. Try: lc ls`, 'usage')
    const r = await resultOf(req.pane)
    return ok({ result: r.result }, r.warning)
  }

  if (req.cmd === 'interrupt') {
    if (!panes.has(req.pane)) return no(`No such pane: ${req.pane}. Try: lc ls`, 'usage')
    // The same mistake the send gate refuses: the turn it would stop is this one.
    if (req.from === req.pane) {
      return no(`${req.pane} is your own pane — interrupting it would stop the turn that asked.`, 'refused')
    }
    const scope = mayAct(req, req.pane)
    if (!scope.allow) return no(scope.error, 'refused')
    const idle =paneStatus.get(req.pane)?.status !== 'working'
    const res = await steer(req.pane, { kind: 'interrupt' }, by(req, scope.warning))
    if (!res.ok) return no(res.error, res.kind)
    return ok(
      {},
      joinWarnings(
        idle ? `${req.pane} was not mid-turn as far as the app knows; the key was sent anyway.` : undefined,
        scope.warning
      )
    )
  }

  if (req.cmd === 'approve') return approve(req)

  if (req.cmd === 'send') return send(req)

  if (req.cmd === 'close') {
    if (!panes.has(req.pane)) return no(`No such pane: ${req.pane}`, 'usage')
    const scope = mayAct(req, req.pane)
    if (!scope.allow) return no(scope.error, 'refused')
    // Deliberately closePane, not the flow that offers to remove worktrees:
    // discarding a checkout is a decision for a person looking at it, not
    // something an agent should be able to ask for down a socket.
    closePane(req.pane)
    return ok({}, scope.warning)
  }

  if (req.cmd === 'wait') {
    return waitFor(req.panes, req.for, Math.max(1000, Math.min(req.timeoutMs, 15 * 60_000)))
  }

  if (req.cmd === 'fan') {
    const count = req.count as AgentCount
    if (!AGENT_COUNTS.includes(count)) {
      return no(`count must be one of ${AGENT_COUNTS.join(', ')}`, 'usage')
    }
    // The caller's own pane decides the repository. Falling back to the focused
    // pane — which is wherever the human last clicked — meant an agent fanning
    // out while its user looked at another project branched the wrong one.
    const caller = req.from ? findPane(req.from) : null
    if (req.from && !caller) return no(`No such pane: ${req.from}`, 'usage')
    const here = caller ?? (state.focusedPaneId ? findPane(state.focusedPaneId) : null)
    const cwd = here?.cwd ?? state.tabs[0]?.projectPath
    if (!cwd) return no('No pane to branch from.', 'refused')
    const created = await runFanOut(cwd, {
      task: req.task,
      count,
      prompt: req.prompt,
      plan: req.plan
    })
    if (created === null) return no('Fan-out failed — see the app for the reason.', 'refused')
    return ok({ created })
  }

  return no('Unknown command.', 'usage')
}

/** Subscribe once, at boot. */
export function initLc(): void {
  statusListeners.add(forgetExpectation)
  window.lightclaude.lc.onRequest((id, req) => {
    void handleLcRequest(req)
      .catch((err: unknown) => no(err instanceof Error ? err.message : String(err), 'transport'))
      .then((res) => window.lightclaude.lc.reply(id, res))
  })
}
