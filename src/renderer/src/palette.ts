import { GROUP_ORDER, availableCommands, allCommands, type Command } from './commands'
import { activateTab, createTab } from './app'
import { fuzzyRank } from './fuzzy'
import { shortcutLabel } from './keys'
import { state, tabStatus } from './store'
import { icon, type IconName } from './ui/icons'
import { openModal } from './ui/modal'

/**
 * The command palette: one box that finds anything — a command, an open tab,
 * a saved project — by typing a few letters of its name.
 *
 * It is the answer to "where is that button": every feature is in the command
 * registry, so a feature the toolbar has no room for, or one reached by a
 * gesture nobody remembers, is still one search away.
 */

interface Item {
  key: string
  title: string
  hint?: string
  keywords?: string
  icon: IconName
  shortcut?: string
  run: () => void
}

const RECENT_KEY = 'lightcode.palette.recent'
const RECENT_MAX = 5

function readRecent(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY)
    const list = raw ? (JSON.parse(raw) as unknown) : []
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

function noteRecent(key: string): void {
  try {
    const next = [key, ...readRecent().filter((k) => k !== key)].slice(0, RECENT_MAX)
    localStorage.setItem(RECENT_KEY, JSON.stringify(next))
  } catch {
    // storage unavailable: the palette works without recents
  }
}

function commandItem(c: Command): Item {
  return {
    key: `cmd:${c.id}`,
    title: c.title,
    hint: c.group,
    keywords: `${c.group} ${c.keywords ?? ''}`,
    icon: c.icon ?? 'command',
    shortcut: c.shortcut ? shortcutLabel(c.shortcut) : undefined,
    run: c.run
  }
}

function tabItems(): Item[] {
  return state.tabs
    .filter((t) => t.id !== state.activeTabId)
    .map((t) => {
      const status = tabStatus(t)
      return {
        key: `tab:${t.id}`,
        title: `Go to ${t.name}`,
        hint: status === 'waiting-approval' ? 'needs approval' : status === 'waiting-input' ? 'waiting' : 'tab',
        keywords: `tab switch ${t.projectPath}`,
        icon: 'terminal' as IconName,
        run: () => activateTab(t.id)
      }
    })
}

async function projectItems(): Promise<Item[]> {
  try {
    const cfg = await window.lightclaude.shortcuts.load()
    return cfg.paths
      .filter((p) => p.name && p.path)
      .map((p) => ({
        key: `proj:${p.path}`,
        title: `Open ${p.name}`,
        hint: 'project',
        keywords: `project folder ${p.path} ${p.category ?? ''}`,
        icon: 'folder' as IconName,
        run: () => void createTab({ projectPath: p.path, name: p.name })
      }))
  } catch {
    return []
  }
}

let open: { close: () => void } | null = null

export function togglePalette(): void {
  if (open) {
    open.close()
    return
  }
  void openPalette()
}

export async function openPalette(): Promise<void> {
  if (open) return
  const previous = document.activeElement as HTMLElement | null

  const overlay = document.createElement('div')
  overlay.className = 'palette-overlay'
  const box = document.createElement('div')
  box.className = 'palette'
  box.setAttribute('role', 'dialog')
  box.setAttribute('aria-label', 'Command palette')

  const field = document.createElement('div')
  field.className = 'palette-field'
  const searchIcon = document.createElement('span')
  searchIcon.className = 'palette-search-icon'
  searchIcon.innerHTML = icon('search', 16) // constant SVG only
  const input = document.createElement('input')
  input.className = 'palette-input'
  input.placeholder = 'Search commands, tabs and projects…'
  input.spellcheck = false
  input.setAttribute('aria-label', 'Search')
  field.append(searchIcon, input)

  const list = document.createElement('div')
  list.className = 'palette-list'
  list.setAttribute('role', 'listbox')
  const foot = document.createElement('div')
  foot.className = 'palette-foot'
  foot.textContent = '↑↓ to move · Enter to run · Esc to close'

  box.append(field, list, foot)
  overlay.appendChild(box)
  document.body.appendChild(overlay)

  let items: Item[] = []
  let shown: Item[] = []
  let active = 0
  let projects: Item[] = []

  const close = (): void => {
    if (!open) return
    open = null
    document.removeEventListener('keydown', onKey, { capture: true })
    overlay.remove()
    if (previous && previous.isConnected) previous.focus()
  }
  open = { close }

  const run = (item: Item | undefined): void => {
    if (!item) return
    noteRecent(item.key)
    close()
    // After closing, so whatever it opens gets focus rather than losing it to
    // the restore above.
    window.setTimeout(item.run, 0)
  }

  const render = (): void => {
    const q = input.value
    const pool = [...items, ...tabItems(), ...projects]
    if (q.trim() === '') {
      const recent = readRecent()
      const byKey = new Map(pool.map((i) => [i.key, i]))
      const recents = recent.map((k) => byKey.get(k)).filter((i): i is Item => !!i)
      const rest = items.filter((i) => !recent.includes(i.key))
      shown = [...recents, ...rest]
    } else {
      shown = fuzzyRank(q, pool, (i) => [i.title, i.keywords ?? ''])
    }
    active = Math.min(active, Math.max(0, shown.length - 1))
    list.replaceChildren()
    if (shown.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'palette-empty'
      empty.textContent = 'Nothing matches.'
      list.appendChild(empty)
      return
    }
    shown.forEach((item, i) => {
      const row = document.createElement('div')
      row.className = 'palette-row' + (i === active ? ' active' : '')
      row.setAttribute('role', 'option')
      row.setAttribute('aria-selected', String(i === active))
      const ic = document.createElement('span')
      ic.className = 'palette-row-icon'
      ic.innerHTML = icon(item.icon, 16) // constant SVG only
      const title = document.createElement('span')
      title.className = 'palette-row-title'
      title.textContent = item.title
      row.append(ic, title)
      if (item.hint) {
        const hint = document.createElement('span')
        hint.className = 'palette-row-hint'
        hint.textContent = item.hint
        row.appendChild(hint)
      }
      if (item.shortcut) {
        const k = document.createElement('span')
        k.className = 'kbd'
        k.textContent = item.shortcut
        row.appendChild(k)
      }
      row.addEventListener('pointermove', () => {
        if (active === i) return
        active = i
        updateActive()
      })
      row.addEventListener('click', () => run(item))
      list.appendChild(row)
    })
  }

  const updateActive = (): void => {
    ;[...list.children].forEach((el, i) => {
      el.classList.toggle('active', i === active)
      el.setAttribute('aria-selected', String(i === active))
    })
    ;(list.children[active] as HTMLElement | undefined)?.scrollIntoView({ block: 'nearest' })
  }

  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      close()
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      active = Math.min(active + 1, shown.length - 1)
      updateActive()
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      active = Math.max(active - 1, 0)
      updateActive()
    } else if (e.key === 'Enter') {
      e.preventDefault()
      e.stopPropagation()
      run(shown[active])
    }
  }

  overlay.addEventListener('pointerdown', (e) => {
    if (e.target === overlay) close()
  })
  input.addEventListener('input', () => {
    active = 0
    render()
  })
  document.addEventListener('keydown', onKey, { capture: true })

  // Not itself: "Command palette" inside the palette is just noise.
  items = availableCommands()
    .filter((c) => c.id !== 'palette')
    .map(commandItem)
  render()
  input.focus()
  // Saved projects come from disk; add them when they arrive.
  projects = await projectItems()
  if (open) render()
}

/** Every shortcut, grouped — the answer to "what was the key for…". */
export function openShortcutHelp(): void {
  const m = openModal({
    title: 'Keyboard shortcuts',
    subtitle: 'Everything else is in the command palette.',
    icon: 'keyboard',
    className: 'shortcut-help-modal'
  })
  m.body.classList.add('shortcut-help')
  const withKeys = allCommands().filter((c) => c.shortcut)
  for (const group of GROUP_ORDER) {
    const rows = withKeys.filter((c) => c.group === group)
    if (rows.length === 0) continue
    const section = document.createElement('section')
    const h = document.createElement('h3')
    h.textContent = group
    section.appendChild(h)
    for (const c of rows) {
      const row = document.createElement('div')
      row.className = 'shortcut-row'
      const name = document.createElement('span')
      name.textContent = c.title
      const k = document.createElement('span')
      k.className = 'kbd'
      k.textContent = shortcutLabel(c.shortcut!)
      row.append(name, k)
      section.appendChild(row)
    }
    m.body.appendChild(section)
  }
  m.footer.remove()
}
