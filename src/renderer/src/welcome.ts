import { addTab, addTabViaPicker, createTab } from './app'
import { allCommands } from './commands'
import { shortcutLabel } from './keys'
import { openShortcutHelp } from './palette'
import { recentProjects } from './recentProjects'
import { state } from './store'
import { icon, type IconName } from './ui/icons'
import { logoSvg } from './ui/logo'
import { openSetup, refreshTools, toolRow } from './setup'
import { toolsFor, type ToolStatus } from '../../shared/tools'

/**
 * The welcome page: what the window shows when no tab is open — on the very
 * first launch, and whenever the last tab is closed.
 *
 * It never stands in the way. Enter (or the big button) opens a plain terminal
 * at once, exactly what the app did before this page existed; everything else
 * here is an offer, not a step.
 */

function basename(p: string): string {
  const parts = p.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] || p
}

function runCommand(id: string): void {
  allCommands()
    .find((c) => c.id === id)
    ?.run()
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text !== undefined) e.textContent = text
  return e
}

function iconSpan(name: IconName, size = 16, cls = 'wl-icon'): HTMLSpanElement {
  const s = el('span', cls)
  s.innerHTML = icon(name, size) // constant SVG only
  return s
}

const FEATURES: { icon: IconName; title: string; text: string; command: string }[] = [
  {
    icon: 'fanOut',
    title: 'Fan-out',
    text: 'Give one task to several agents at once, each on its own branch. Keep the best answer.',
    command: 'fan-out'
  },
  {
    icon: 'orchestra',
    title: 'Orchestra',
    text: 'One lead pane directs the others and you watch every worker from one place.',
    command: 'squad'
  },
  {
    icon: 'mission',
    title: 'Mission Control',
    text: 'Every Claude session in the window at a glance. Send one message to many.',
    command: 'mission'
  }
]

async function savedProjects(): Promise<{ name: string; path: string }[]> {
  try {
    const cfg = await window.lightclaude.shortcuts.load()
    return cfg.paths.filter((p) => p.name && p.path).map((p) => ({ name: p.name, path: p.path }))
  } catch {
    return []
  }
}

async function render(root: HTMLElement): Promise<void> {
  root.replaceChildren()
  const page = el('div', 'welcome')

  // Brand
  const hero = el('div', 'wl-hero')
  const logo = el('div', 'wl-logo')
  logo.innerHTML = logoSvg({ size: 88, animated: true }) // constant SVG only
  hero.append(logo, el('h1', 'wl-title', 'Light Code'), el('p', 'wl-tagline', 'Terminals for Claude Code. Many agents, one calm window.'))

  // Start
  const actions = el('div', 'wl-actions')
  const newTerm = el('button', 'btn btn-primary wl-primary')
  newTerm.append(iconSpan('terminal', 16), el('span', undefined, 'New terminal'), Object.assign(el('span', 'kbd wl-enter'), { textContent: '↵' }))
  newTerm.addEventListener('click', () => void addTab())
  const openProj = el('button', 'btn')
  openProj.append(iconSpan('folder', 16), el('span', undefined, 'Open project…'))
  openProj.addEventListener('click', () => void addTabViaPicker())
  actions.append(newTerm, openProj)
  hero.appendChild(actions)
  page.appendChild(hero)

  // Agent CLIs: what is installed, and one click to install the rest.
  const agents = el('section', 'wl-section')
  const agentsHead = el('div', 'wl-section-head')
  agentsHead.appendChild(el('h2', undefined, 'Agent CLIs'))
  const setupBtn = el('button', 'btn btn-ghost btn-sm', 'Setup & tools')
  setupBtn.addEventListener('click', openSetup)
  agentsHead.appendChild(setupBtn)
  const agentList = el('div', 'tool-list wl-tools')
  const paint = (s: ToolStatus[] | null): void => {
    agentList.replaceChildren(...toolsFor(window.lightclaude.platform, 'agent').map((t) => toolRow(t, s?.find((x) => x.id === t.id), true)))
  }
  paint(null)
  void refreshTools().then(paint)
  agents.append(agentsHead, agentList)
  page.appendChild(agents)

  // Projects: saved shortcuts first, then recent folders not already listed.
  const saved = await savedProjects()
  const known = new Set(saved.map((p) => p.path.toLowerCase()))
  const recent = recentProjects()
    .filter((p) => !known.has(p.toLowerCase()))
    .map((p) => ({ name: basename(p), path: p }))
  const projects = [...saved, ...recent].slice(0, 6)
  if (projects.length > 0) {
    const section = el('section', 'wl-section')
    const head = el('div', 'wl-section-head')
    head.appendChild(el('h2', undefined, 'Projects'))
    const manage = el('button', 'btn btn-ghost btn-sm', 'Manage')
    manage.addEventListener('click', () => runCommand('projects'))
    head.appendChild(manage)
    section.appendChild(head)
    const list = el('div', 'wl-projects')
    for (const p of projects) {
      const row = el('button', 'wl-project')
      row.title = p.path
      const text = el('span', 'wl-project-text')
      text.append(el('span', 'wl-project-name', p.name), el('span', 'wl-project-path', p.path))
      row.append(iconSpan('folder', 16), text)
      row.addEventListener('click', () => void createTab({ projectPath: p.path, name: p.name }))
      list.appendChild(row)
    }
    section.appendChild(list)
    page.appendChild(section)
  }

  // What it can do
  const feat = el('section', 'wl-section')
  feat.appendChild(el('h2', undefined, 'When one agent is not enough'))
  const cards = el('div', 'wl-cards')
  for (const f of FEATURES) {
    const card = el('button', 'wl-card')
    const top = el('div', 'wl-card-top')
    top.append(iconSpan(f.icon, 18, 'wl-card-icon'), el('span', 'wl-card-title', f.title))
    card.append(top, el('p', 'wl-card-text', f.text), el('span', 'wl-card-cta', 'Try it →'))
    card.addEventListener('click', () => runCommand(f.command))
    cards.appendChild(card)
  }
  feat.appendChild(cards)
  page.appendChild(feat)

  // Keys
  const keys = el('div', 'wl-keys')
  const hint = (label: string, key: string): void => {
    const h = el('span', 'wl-key')
    h.append(Object.assign(el('span', 'kbd'), { textContent: key }), el('span', undefined, label))
    keys.appendChild(h)
  }
  hint('Command palette', shortcutLabel('command-palette'))
  hint('New tab', shortcutLabel('new-tab'))
  hint('Split right', shortcutLabel('split-right'))
  const all = el('button', 'btn btn-ghost btn-sm', 'All shortcuts')
  all.addEventListener('click', openShortcutHelp)
  keys.appendChild(all)
  page.appendChild(keys)

  root.appendChild(page)
}

let root: HTMLElement | null = null

/** Re-render whenever the page becomes visible, so projects are current. */
export function initWelcome(): void {
  root = document.getElementById('empty-state')
  if (!root) return
  const r = root
  const sync = (): void => {
    if (!r.hidden) void render(r)
  }
  new MutationObserver(sync).observe(r, { attributes: true, attributeFilter: ['hidden'] })
  sync()

  // Enter on the welcome page opens a terminal — the old behaviour, one key away.
  document.addEventListener('keydown', (e) => {
    if (r.hidden || state.tabs.length > 0 || e.key !== 'Enter') return
    const t = e.target as HTMLElement | null
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'BUTTON')) return
    if (document.querySelector('#shortcuts-overlay, .palette-overlay, #mission-overlay')) return
    e.preventDefault()
    void addTab()
  })

  // The logo's idle motion pauses in a hidden window.
  const vis = (): void => {
    document.body.classList.toggle('page-hidden', document.hidden)
  }
  document.addEventListener('visibilitychange', vis)
  vis()
}
