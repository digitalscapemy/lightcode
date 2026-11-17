import { createTab } from './app'
import { newId, pendingCommand, state } from './store'
import { GUIDES, type GuideId } from '../../shared/guides'
import { TOOLS, installCommand, toolById, toolsFor, type ToolDef, type ToolStatus } from '../../shared/tools'
import type { LayoutNode } from '../../shared/types'
import { openGuide } from './ui/guide'
import { icon } from './ui/icons'
import { openModal } from './ui/modal'
import { toast } from './ui/toast'
import type { PermissionCheck } from '../../shared/guides'

/**
 * Setup & tools: which agent CLIs are installed, and installing the ones that
 * are not.
 *
 * Installing types the vendor's official command (shared/tools.ts) into a new
 * terminal tab, in plain view: the user watches it run, can stop it, and sees
 * the real error if there is one. Light Code then checks every few seconds
 * and says so when the tool appears, and new panes get the updated PATH.
 */

const isWin = window.lightclaude.platform === 'win32'

let lastStatus: ToolStatus[] | null = null
const listeners = new Set<(s: ToolStatus[]) => void>()

/** Ask main which tools are installed. Cheap enough to call when a view opens. */
export async function refreshTools(): Promise<ToolStatus[]> {
  try {
    lastStatus = await window.lightclaude.checkTools()
  } catch {
    lastStatus = TOOLS.map((t) => ({ id: t.id, installed: false }))
  }
  for (const l of listeners) l(lastStatus)
  return lastStatus
}

export function onToolsChange(fn: (s: ToolStatus[]) => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

const watching = new Set<string>()

/** Open a tab that runs the official installer, then watch for the result. */
export async function installTool(id: string): Promise<void> {
  const tool = toolById(id)
  if (!tool) return
  const pane: LayoutNode = { type: 'pane', id: newId('p') }
  pendingCommand.set(pane.id, installCommand(tool, window.lightclaude.platform))
  await createTab({
    projectPath: (await window.lightclaude.homedir()) || state.tabs[0]?.projectPath || '',
    name: `Install ${tool.label}`,
    layout: pane
  })
  toast({
    tone: 'info',
    title: `Installing ${tool.label}`,
    detail: 'The official installer is running in the new tab. Light Code will tell you when it is ready.'
  })
  watchInstall(tool)
}

/** Check every 5 s for up to 10 minutes; announce the outcome once. */
function watchInstall(tool: ToolDef): void {
  if (watching.has(tool.id)) return
  watching.add(tool.id)
  const started = Date.now()
  const tick = async (): Promise<void> => {
    const status = (await refreshTools()).find((s) => s.id === tool.id)
    if (status?.installed) {
      watching.delete(tool.id)
      toast({
        tone: 'success',
        title: `${tool.label} is installed`,
        detail: `${status.version ?? tool.bin} · new panes can run "${tool.bin}". Panes that were already open need restarting.`,
        action: { label: 'Why', run: () => openGuide('path-after-install') },
        duration: 9000
      })
      return
    }
    if (Date.now() - started > 10 * 60_000) {
      watching.delete(tool.id)
      toast({
        tone: 'warning',
        title: `${tool.label} was not found yet`,
        detail: 'Check the install tab for an error.',
        action: { label: 'What to do', run: () => openGuide('install-failed') }
      })
      return
    }
    window.setTimeout(() => void tick(), 5000)
  }
  window.setTimeout(() => void tick(), 5000)
}

/** One row per tool: status, version, and Install / Docs. Shared by the modal and the welcome page. */
export function toolRow(tool: ToolDef, status: ToolStatus | undefined, compact = false): HTMLElement {
  const row = document.createElement('div')
  row.className = 'tool-row' + (compact ? ' compact' : '')

  const text = document.createElement('div')
  text.className = 'tool-text'
  const name = document.createElement('div')
  name.className = 'tool-name'
  name.textContent = tool.label
  const chip = document.createElement('span')
  if (status === undefined) {
    chip.className = 'chip'
    chip.textContent = 'Checking…'
  } else if (status.installed) {
    chip.className = 'chip chip-success'
    chip.textContent = status.version ? `Installed · ${status.version}` : 'Installed'
    chip.title = status.path ?? ''
  } else {
    chip.className = 'chip'
    chip.textContent = 'Not installed'
  }
  name.appendChild(chip)
  text.appendChild(name)
  if (!compact) {
    const blurb = document.createElement('div')
    blurb.className = 'tool-blurb'
    blurb.textContent =
      status && !status.installed && tool.installNote ? `${tool.blurb} ${tool.installNote}` : tool.blurb
    text.appendChild(blurb)
  }
  row.appendChild(text)

  const actions = document.createElement('div')
  actions.className = 'tool-actions'
  if (status && !status.installed) {
    const install = document.createElement('button')
    install.className = 'btn btn-primary btn-sm'
    install.textContent = watching.has(tool.id) ? 'Installing…' : 'Install'
    install.disabled = watching.has(tool.id)
    install.title = installCommand(tool, window.lightclaude.platform)
    install.addEventListener('click', () => void installTool(tool.id))
    actions.appendChild(install)
  }
  if (!compact) {
    const docs = document.createElement('button')
    docs.className = 'btn btn-ghost btn-sm'
    docs.textContent = 'Docs'
    docs.addEventListener('click', () => window.lightclaude.openExternal(tool.docs))
    actions.appendChild(docs)
  }
  row.appendChild(actions)
  return row
}

/**
 * The installation section: agent CLIs, system tools (WSL, Docker), the
 * permission checks and the guides. Built once here and placed both in the
 * Setup & tools dialog and in Settings, so the two can never disagree.
 * Every tool is optional; a missing one only offers its Install button.
 */
export function buildInstallSection(): { el: HTMLElement; recheck: () => void; dispose: () => void } {
  const el = document.createElement('div')
  el.className = 'install-section'
  const plat = window.lightclaude.platform

  const listFor = (group: 'agent' | 'system'): { list: HTMLElement; render: (s: ToolStatus[] | null) => void } => {
    const list = document.createElement('div')
    list.className = 'tool-list'
    const render = (s: ToolStatus[] | null): void => {
      list.replaceChildren(...toolsFor(plat, group).map((t) => toolRow(t, s?.find((x) => x.id === t.id))))
    }
    return { list, render }
  }
  const agents = listFor('agent')
  const system = listFor('system')
  const renderAll = (s: ToolStatus[] | null): void => {
    agents.render(s)
    system.render(s)
  }
  renderAll(lastStatus)
  const off = onToolsChange(renderAll)
  void refreshTools()

  const head = (text: string): HTMLElement => {
    const h = document.createElement('h3')
    h.className = 'setup-head'
    h.textContent = text
    return h
  }
  const note = document.createElement('p')
  note.className = 'setup-note'
  note.textContent =
    'All optional. Install opens a new tab and runs the official command from the vendor, so you can watch it and stop it.'

  // Permissions: can Light Code write what its features need?
  const permList = document.createElement('div')
  permList.className = 'tool-list perm-list'
  const renderPerms = (checks: PermissionCheck[] | null): void => {
    if (checks === null) {
      const row = document.createElement('div')
      row.className = 'tool-row compact'
      row.textContent = 'Checking…'
      permList.replaceChildren(row)
      return
    }
    permList.replaceChildren(...checks.map(permRow))
  }
  const runPerms = async (): Promise<void> => {
    renderPerms(null)
    try {
      renderPerms(await window.lightclaude.checkPermissions())
    } catch {
      renderPerms([])
    }
  }
  void runPerms()

  const guides = document.createElement('div')
  guides.className = 'guide-links'
  const ids: GuideId[] = isWin
    ? ['execution-policy', 'controlled-folder-access', 'path-after-install', 'install-failed']
    : ['path-after-install', 'install-failed']
  for (const id of ids) {
    const b = document.createElement('button')
    b.className = 'guide-link'
    const ic = document.createElement('span')
    ic.className = 'guide-link-icon'
    ic.innerHTML = icon('info', 16) // constant SVG only
    const t = document.createElement('span')
    t.textContent = GUIDES[id].title
    b.append(ic, t)
    b.addEventListener('click', () => openGuide(id))
    guides.appendChild(b)
  }

  el.append(
    head('Agent CLIs'),
    agents.list,
    note,
    head(isWin ? 'WSL and Docker' : 'Docker'),
    system.list,
    head('Permissions'),
    permList,
    head('Help with things Light Code cannot change'),
    guides
  )
  return {
    el,
    recheck: () => {
      void refreshTools()
      void runPerms()
    },
    dispose: off
  }
}

/** The Setup & tools dialog: the installation section on its own. */
export function openSetup(): void {
  const m = openModal({
    title: 'Setup & tools',
    subtitle: 'The tools Light Code can run, and help with what it cannot change for you.',
    icon: 'sparkle',
    className: 'setup-modal'
  })
  const section = buildInstallSection()
  m.body.appendChild(section.el)

  const recheck = document.createElement('button')
  recheck.className = 'shortcuts-secondary'
  recheck.textContent = 'Check again'
  recheck.addEventListener('click', section.recheck)
  const done = document.createElement('button')
  done.className = 'shortcuts-primary'
  done.textContent = 'Done'
  done.addEventListener('click', () => m.close())
  const spacer = document.createElement('div')
  spacer.style.flex = '1'
  m.footer.append(recheck, spacer, done)
  disposeWhenGone(m.overlay, section.dispose)
}

/** Run `fn` once `node` has left the page, however it was closed. */
export function disposeWhenGone(node: HTMLElement, fn: () => void): void {
  new MutationObserver((_r, obs) => {
    if (!node.isConnected) {
      fn()
      obs.disconnect()
    }
  }).observe(document.body, { childList: true })
}

/** One permission check: a tick or a warning, what it is about, and the fix. */
function permRow(c: PermissionCheck): HTMLElement {
  const row = document.createElement('div')
  row.className = 'tool-row compact perm-row' + (c.ok ? ' ok' : ' bad')
  const ic = document.createElement('span')
  ic.className = 'perm-icon'
  ic.innerHTML = icon(c.ok ? 'check' : 'warning', 16) // constant SVG only
  const text = document.createElement('div')
  text.className = 'tool-text'
  const label = document.createElement('div')
  label.className = 'tool-name'
  label.textContent = c.label
  const detail = document.createElement('div')
  detail.className = 'tool-blurb perm-detail'
  detail.textContent = c.detail
  detail.title = c.detail
  text.append(label, detail)
  row.append(ic, text)
  if (!c.ok && c.guide) {
    const fix = document.createElement('button')
    fix.className = 'btn btn-sm'
    fix.textContent = 'How to fix'
    const id = c.guide
    fix.addEventListener('click', () => openGuide(id))
    row.appendChild(fix)
  }
  return row
}
