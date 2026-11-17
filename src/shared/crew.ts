import type { PaneStatus } from './ipc'
import type { Orientation, PaneNode, PaneNodeCrew } from './types'

/**
 * Crews: panes that work together, and what has to stay true about them as the
 * layout around them changes.
 *
 * Pure, and shared, because both the layout code and the tests need the same
 * answers without a window to ask.
 *
 * A crew is an orchestra lead and the workers it drives. Membership lives on
 * each pane's own layout node (PaneNode.crew), so it is saved, restored and
 * carried through a reshape by the code that already does those things for a
 * pane's name and folder. Nothing here holds state of its own.
 */

/**
 * Copy what a pane remembers about itself onto the node that replaces it.
 *
 * Reshaping a tab builds a fresh tree from a preset, and the preset knows only
 * pane ids. Everything else on the old node — its title, its folder, its squad
 * role — has to be carried across by hand, and the hand-written version copied
 * `cwd` and `name` and nothing more. A reshape therefore stripped every squad
 * pane of its role on disk while the pane on screen still showed it, and the
 * next restart brought the squad back as plain terminals.
 *
 * Everything except identity is carried, rather than a list of known fields,
 * so a field added to PaneNode later survives a reshape without anyone having
 * to remember this function exists. `type` and `id` belong to the new node.
 *
 * Mutates and returns `to`; `from` is left alone.
 */
export function carryNodeMeta(from: PaneNode | undefined, to: PaneNode): PaneNode {
  if (!from) return to
  const { type: _type, id: _id, ...meta } = from
  return Object.assign(to, meta)
}

/** FNV-1a, 32 bits. Stable across runs and platforms, which is all it is for. */
function hash(text: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/**
 * The crew id a squad folder stands for.
 *
 * Derived rather than minted so that the squad that opens today and the squad
 * from before crews existed, adopted on restore, arrive at the same id — and so
 * a pane adopted later joins the crew its siblings are already in.
 */
export function crewIdFor(squadDir: string): string {
  return `c_${hash(squadDir.replace(/\\/g, '/')).toString(36)}`
}

/**
 * The colour a crew is drawn in, as a hue in degrees.
 *
 * From the id, so the same crew is the same colour after a restart and two
 * crews in one window are told apart without anyone choosing a palette.
 */
export function crewHue(crewId: string): number {
  return hash(crewId) % 360
}

/** What a handle may look like: something you can type after an @ in a shell. */
const HANDLE = /^[a-z0-9][a-z0-9-]{0,23}$/

/**
 * `@lead` always means the crew's lead (resolveTarget looks it up before any
 * handle), so a worker called `lead` could never be reached by its own name.
 * The lead itself may wear it: there the two meanings agree.
 */
const LEAD_HANDLE = 'lead'

function takenSet(taken: Iterable<string>, lead: boolean): Set<string> {
  const used = new Set([...taken].map((h) => h.toLowerCase()))
  if (!lead) used.add(LEAD_HANDLE)
  return used
}

/**
 * A free handle, as close to `base` as the crew allows.
 *
 * `base` is usually a role id or a word somebody typed, so it is folded into
 * handle shape first; a second developer becomes `developer-2` rather than
 * being refused, because the person asked for a developer, not for a name.
 * Only a lead (`lead` true) is handed `lead` itself; a worker gets `lead-2`.
 */
export function nextHandle(base: string, taken: Iterable<string>, lead = false): string {
  const used = takenSet(taken, lead)
  const slug =
    base
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 20)
      .replace(/-+$/, '') || 'worker'
  if (!used.has(slug)) return slug
  for (let i = 2; ; i++) {
    const candidate = `${slug}-${i}`
    if (!used.has(candidate)) return candidate
  }
}

/** Why a typed handle will not do, or null when it will. For the dialogs. */
export function handleError(
  value: string,
  taken: Iterable<string>,
  lead = false
): string | null {
  if (!HANDLE.test(value)) {
    return 'Lowercase letters, digits and dashes, starting with a letter or digit — up to 24.'
  }
  if (!lead && value === LEAD_HANDLE) {
    return "@lead always means the orchestra's lead — pick another name for a worker."
  }
  if (new Set([...taken].map((h) => h.toLowerCase())).has(value)) {
    return `@${value} is already in this orchestra.`
  }
  return null
}

/** Members of one crew, in the order given (reading order, when from a layout). */
export function crewMembers(nodes: PaneNode[], crewId: string): PaneNode[] {
  return nodes.filter((n) => n.crew?.id === crewId)
}

function validCrew(crew: unknown): crew is PaneNodeCrew {
  return (
    typeof crew === 'object' &&
    crew !== null &&
    typeof (crew as PaneNodeCrew).id === 'string' &&
    (crew as PaneNodeCrew).id !== ''
  )
}

/**
 * Settle every crew into a shape the rest of the app can rely on.
 *
 * A crew can be bent out of shape by things that are nobody's fault: a state
 * file from another version, a lead closed out from under its workers, two
 * panes linked under the same name. None of these is worth an error, so this
 * repairs them softly and in place:
 *
 *  - a crew field that is not a crew at all is dropped;
 *  - a member with no handle is given one;
 *  - a second lead stops being one — the first in reading order keeps it;
 *  - a handle used twice is renamed on its second holder, and a worker
 *    called `lead` is renamed too (`@lead` is the lead's, whatever its handle);
 *  - a lone member that is not a lead is unlinked: a crew of one worker and
 *    nobody to direct it is just a pane with a chip on it.
 *
 * A lead alone is kept. That is an orchestra waiting for its first worker,
 * which is exactly what "Conduct from here" makes.
 *
 * Mutates the nodes; returns how many it changed.
 */
export function normaliseCrews(nodes: PaneNode[]): number {
  let changed = 0
  const groups = new Map<string, PaneNode[]>()
  for (const node of nodes) {
    if (node.crew === undefined) continue
    if (!validCrew(node.crew)) {
      delete node.crew
      changed++
      continue
    }
    const group = groups.get(node.crew.id) ?? []
    group.push(node)
    groups.set(node.crew.id, group)
  }

  for (const members of groups.values()) {
    let lead: PaneNode | null = null
    const taken: string[] = []
    for (const node of members) {
      const crew = node.crew!
      if (crew.lead !== undefined && crew.lead !== true) {
        delete crew.lead
        changed++
      }
      if (crew.lead) {
        if (lead === null) lead = node
        else {
          delete crew.lead
          changed++
        }
      }
      if (crew.stripCollapsed !== undefined && crew.stripCollapsed !== true) {
        delete crew.stripCollapsed
        changed++
      }
      const handle = typeof crew.handle === 'string' ? crew.handle.toLowerCase() : ''
      const isLead = crew.lead === true
      if (!HANDLE.test(handle) || taken.includes(handle) || (!isLead && handle === LEAD_HANDLE)) {
        crew.handle = nextHandle(
          HANDLE.test(handle) ? handle : (node.role?.id ?? 'worker'),
          taken,
          isLead
        )
        changed++
      } else if (crew.handle !== handle) {
        crew.handle = handle
        changed++
      }
      taken.push(crew.handle)
    }
    if (members.length === 1 && lead === null) {
      delete members[0]!.crew
      changed++
    }
  }
  return changed
}

/**
 * Turn squads opened before crews existed into crews.
 *
 * Those panes remember their role and their squad folder and nothing else, so
 * the folder is what groups them: every pane pointing at one squad folder was
 * opened by one squad. Its id comes from the folder (crewIdFor), which is also
 * how a squad opened today names its crew, so the two cannot disagree. The
 * orchestrator role leads; every handle is the role id.
 *
 * Panes that already have a crew are left as they are. Mutates the nodes;
 * returns how many it adopted. Run normaliseCrews afterwards — a squad whose
 * other panes were closed leaves a lone worker, and that is its job to tidy.
 */
export function adoptLegacySquads(
  nodes: PaneNode[],
  isLeadRole: (roleId: string) => boolean = (id) => id === 'orchestrator'
): number {
  let adopted = 0
  for (const node of nodes) {
    if (node.crew !== undefined || !node.role || typeof node.role.squadDir !== 'string') continue
    const id = crewIdFor(node.role.squadDir)
    const members = crewMembers(nodes, id)
    const lead = isLeadRole(node.role.id) && !members.some((m) => m.crew!.lead)
    const crew: PaneNodeCrew = {
      id,
      handle: nextHandle(
        node.role.id,
        members.map((m) => m.crew!.handle),
        lead
      )
    }
    if (lead) crew.lead = true
    node.crew = crew
    adopted++
  }
  return adopted
}

/** One pane as target resolution needs to see it. */
export interface CrewPane {
  pane: string
  crew?: PaneNodeCrew
  /** Squad role id, which `@role` matches when no handle does. */
  role?: string | null
}

export type Resolved = { panes: string[] } | { error: string }

/**
 * What `lc` means by a target.
 *
 *  - `p_xxx`  that pane, untouched — whether it exists is the caller's question;
 *  - `@lead`  the lead of your crew;
 *  - `@*`     everyone in your crew but you;
 *  - `@name`  the member of your crew with that handle, or failing that the one
 *             holding that role.
 *
 * Inside your own crew first, because that is what a lead addressing
 * `@developer` means, and two orchestras in one window each have one. Only
 * when your crew has nobody by that name is the rest of the window searched —
 * a person in a plain pane addressing a crew by handle is a reasonable thing to
 * do, and whether driving it is wise is canDrive's question, not this one's.
 *
 * A name that matches more than one pane is refused rather than guessed at:
 * sending to the wrong one of two developers is worse than being asked which.
 */
export function resolveTarget(target: string, from: string | undefined, all: CrewPane[]): Resolved {
  if (!target.startsWith('@')) return { panes: [target] }
  const name = target.slice(1).toLowerCase()
  if (name === '') return { error: 'An @ needs a name after it: @lead, @*, or a handle from `lc ls --crew`.' }
  const own = all.find((p) => p.pane === from)?.crew?.id
  const mine = own === undefined ? [] : all.filter((p) => p.crew?.id === own)

  if (name === '*') {
    if (own === undefined) {
      return { error: '@* means everyone in your crew, and this pane is not in one.' }
    }
    const others = mine.filter((p) => p.pane !== from).map((p) => p.pane)
    if (others.length === 0) return { error: 'Your crew has nobody in it but you yet.' }
    return { panes: others }
  }

  const pick = (found: CrewPane[]): Resolved | null => {
    if (found.length === 1) return { panes: [found[0]!.pane] }
    if (found.length > 1) {
      return {
        error: `${target} could mean ${found.map((p) => p.pane).join(' or ')}. Name the pane id instead.`
      }
    }
    return null
  }

  if (name === 'lead') {
    const leads = (own === undefined ? all : mine).filter((p) => p.crew?.lead)
    const hit = pick(leads)
    if (hit) return hit
    return {
      error:
        own === undefined
          ? 'There is no orchestra lead in this window to address.'
          : 'Your crew has no lead right now.'
    }
  }

  const byHandle = (pool: CrewPane[]): CrewPane[] => pool.filter((p) => p.crew?.handle === name)
  const byRole = (pool: CrewPane[]): CrewPane[] => pool.filter((p) => p.role === name)
  for (const pool of own === undefined ? [all] : [mine, all]) {
    const hit = pick(byHandle(pool)) ?? pick(byRole(pool))
    if (hit) return hit
  }
  return { error: `Nobody answers to ${target}. Try: lc ls --crew` }
}

export type DriveVerdict = { allow: true; warning?: string } | { allow: false; error: string }

/**
 * Whether one pane may drive another, judged by crew.
 *
 * Warn, never block — by default. Driving outside your crew, or a worker
 * driving its own lead, is usually a mistake but not always one, so it goes
 * through with a warning the caller reads on stderr and an amber badge the
 * person sees on the pane. Only a crew the person has marked strict turns those
 * warnings into refusals; `strict` is true when either side's crew is.
 *
 * Panes outside any crew, driven by panes outside any crew, are not this
 * function's business: that is how `lc` worked before crews, and it still does.
 * Nor is a caller nobody can name — except where a crew is strict: there a
 * caller without the app's token could be claiming to be anyone, so it is
 * refused rather than taken at its word.
 */
export function canDrive(o: {
  from: string | undefined
  fromCrew: PaneNodeCrew | undefined
  target: string
  targetCrew: PaneNodeCrew | undefined
  strict: boolean
  unverified?: boolean
}): DriveVerdict {
  if (o.strict && (o.from === undefined || o.unverified === true)) {
    return {
      allow: false,
      error: 'This crew is set to strict, and only lc run from a pane the app started (with its token) may drive it.'
    }
  }
  if (o.from === undefined) return { allow: true }
  const { fromCrew, targetCrew } = o
  let concern: string | null = null
  if (fromCrew && targetCrew && fromCrew.id === targetCrew.id) {
    if (!fromCrew.lead && targetCrew.lead) {
      concern =
        `${o.target} is your lead (@${targetCrew.handle}). Workers report through the squad ` +
        'folder; typing into the lead lands in the middle of whatever it is directing.'
    }
  } else if (fromCrew && targetCrew) {
    concern = `${o.target} (@${targetCrew.handle}) plays in another orchestra, not yours.`
  } else if (fromCrew) {
    concern = `${o.target} is outside your crew.`
  } else if (targetCrew) {
    concern =
      `${o.target} is @${targetCrew.handle} in an orchestra you are not part of; ` +
      'its lead may be driving it too.'
  }
  if (concern === null) return { allow: true }
  if (o.strict) return { allow: false, error: `${concern} This crew is set to strict, so it was not done.` }
  return { allow: true, warning: concern }
}

const STATUS_RANK: Record<PaneStatus, number> = {
  'waiting-approval': 3,
  'waiting-input': 2,
  working: 1,
  idle: 0
}

/**
 * The status a crew is shown with: its neediest member's.
 *
 * A worker blocked on a permission prompt outranks everything, because nothing
 * in the crew moves past it until a person answers. Members with no status
 * count as idle; an empty crew is idle.
 */
export function crewStatus(statuses: (PaneStatus | undefined)[]): PaneStatus {
  let worst: PaneStatus = 'idle'
  for (const s of statuses) if (s && STATUS_RANK[s] > STATUS_RANK[worst]) worst = s
  return worst
}

/** A pane's place in its tab, as fractions of the tab (paneNav.paneRects). */
export interface CrewRect {
  id: string
  x: number
  y: number
  w: number
  h: number
}

export interface LinkSegment {
  /** The worker the line runs to. */
  pane: string
  x1: number
  y1: number
  x2: number
  y2: number
}

/**
 * The lines from a lead to each of its workers, centre to centre, in the same
 * 0..1 fractions as the rects — ready for an SVG with a 0 0 1 1 viewBox.
 *
 * Only members with a rect are drawn: a worker in another tab is not on this
 * screen to point at. No lead on screen, no lines.
 */
export function linkSegments(rects: CrewRect[], members: { pane: string; lead?: boolean }[]): LinkSegment[] {
  const at = new Map(rects.map((r) => [r.id, r]))
  const lead = members.find((m) => m.lead && at.has(m.pane))
  if (!lead) return []
  const from = at.get(lead.pane)!
  const out: LinkSegment[] = []
  for (const m of members) {
    if (m === lead) continue
    const r = at.get(m.pane)
    if (!r) continue
    out.push({
      pane: m.pane,
      x1: from.x + from.w / 2,
      y1: from.y + from.h / 2,
      x2: r.x + r.w / 2,
      y2: r.y + r.h / 2
    })
  }
  return out
}

/**
 * Where a new worker goes: beside the largest worker already on screen, or to
 * the right of the lead when there are none yet.
 *
 * The largest, because splitting it costs the least legibility; across its
 * longer side, so a tall column of workers grows another row rather than
 * shredding into slivers.
 */
export function workerSlot(
  rects: CrewRect[],
  leadId: string,
  workerIds: string[]
): { target: string; orientation: Orientation } {
  let best: CrewRect | null = null
  for (const r of rects) {
    if (!workerIds.includes(r.id)) continue
    if (best === null || r.w * r.h > best.w * best.h) best = r
  }
  if (best === null) return { target: leadId, orientation: 'row' }
  return { target: best.id, orientation: best.w > best.h ? 'row' : 'column' }
}

/**
 * What happened in a crew, as `lc events` reports it and the panel's timeline
 * will show it. Only crew members produce these; a plain pane never does.
 *
 *  - `status`      the member's agent moved: working, waiting, approval, idle;
 *  - `spawned`     a worker was opened (`lc spawn`);
 *  - `sent`        text was typed into it from outside, by `by`;
 *  - `approved` / `denied` / `interrupted`  its prompt answered, its turn stopped;
 *  - `exited` / `closed`  its shell ended, or the pane went;
 *  - `paused` / `resumed`  the person took the baton back, or handed it over;
 *  - `reported`    it filed a report in the squad folder (`detail` is the file).
 */
export type CrewEventKind =
  | 'status'
  | 'spawned'
  | 'sent'
  | 'approved'
  | 'denied'
  | 'interrupted'
  | 'exited'
  | 'closed'
  | 'paused'
  | 'resumed'
  | 'reported'

export interface CrewEvent {
  /** Rises by one per event, across every crew. `lc events --since` takes it. */
  seq: number
  /** When, in ms. */
  at: number
  crew: string
  pane: string
  handle: string
  kind: CrewEventKind
  /** For `status`: the word `lc ls` would show (working, waiting, approval, idle). */
  state?: string
  /** Who did it: `you` (a person), `@handle`, or a pane id. */
  by?: string
  /** A short note: the first of the text sent, the tool asked about. */
  detail?: string
}

/**
 * Rows in reading order, with each crew's members pulled together at the
 * place its first member appears — Mission Control's grouping. Rows in no
 * crew stay where they were, so a list with no crew in it comes back as one
 * plain group, exactly as it went in. Pure.
 */
export function groupByCrew<T>(
  items: T[],
  crewOf: (item: T) => string | undefined
): { crew: string | null; items: T[] }[] {
  const out: { crew: string | null; items: T[] }[] = []
  const byCrew = new Map<string, T[]>()
  for (const item of items) {
    const crew = crewOf(item)
    if (crew === undefined) {
      const last = out[out.length - 1]
      if (last && last.crew === null) last.items.push(item)
      else out.push({ crew: null, items: [item] })
      continue
    }
    const group = byCrew.get(crew)
    if (group) group.push(item)
    else {
      const fresh = [item]
      byCrew.set(crew, fresh)
      out.push({ crew, items: fresh })
    }
  }
  return out
}
