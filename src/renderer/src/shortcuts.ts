import { accountTarget, isInside, isValidCategory, projectTarget } from '../../shared/shortcutPaths'
import { PROVIDERS, PROVIDER_IDS, providerOf, type AccountProvider } from '../../shared/accountProviders'
import type { AccountShortcut, LayoutNode, PathShortcut, ShortcutsConfig } from '../../shared/types'
import { GUIDES } from '../../shared/guides'
import { createTab } from './app'
import { confirmDialog } from './confirmDialog'
import { activeTab, newId, pendingCommand } from './store'
import { openGuide } from './ui/guide'
import { icon } from './ui/icons'
import { openModal, type ModalHandle } from './ui/modal'
import { toast } from './ui/toast'

/**
 * Projects and accounts, as a picker: one card per entry, like a browser's
 * "who's using" screen. Click a project to open it in a new tab; click an
 * account to start its CLI in a new tab. Each card edits and deletes from its
 * corner, and the last card adds a new one.
 *
 * Every change is saved as it is made (the old manager had one Save for a
 * whole table). Saving still writes shortcuts.json first and $PROFILE second,
 * so the shortcuts work in Light Code panes even when Windows blocks $PROFILE.
 */

type Kind = 'paths' | 'accounts'

const isWin = window.lightclaude.platform === 'win32'
const sep = isWin ? '\\' : '/'
const profileLabel = isWin ? '$PROFILE' : '~/.zshrc'

let paths: PathShortcut[] = []
let accounts: AccountShortcut[] = []
let projectRoot = ''
let categories: string[] = []
let home = ''

let m: ModalHandle | null = null
let kind: Kind = 'paths'
let filter = ''
let providerFilter: AccountProvider | 'all' = 'all'
let statusEl: HTMLElement | null = null

export function initShortcutsUi(): void {
  document.getElementById('projects-btn')!.addEventListener('click', () => void openManager('paths'))
  document.getElementById('accounts-btn')!.addEventListener('click', () => void openManager('accounts'))
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text !== undefined) e.textContent = text
  return e
}

function iconBtn(name: Parameters<typeof icon>[0], title: string, cls = 'pf-icon-btn'): HTMLButtonElement {
  const b = el('button', cls)
  b.innerHTML = icon(name, 14) // constant SVG only
  b.title = title
  b.setAttribute('aria-label', title)
  return b
}

async function load(): Promise<void> {
  const [cfg, homeDir] = await Promise.all([window.lightclaude.shortcuts.load(), window.lightclaude.homedir()])
  home = homeDir
  paths = cfg.paths.map((p) => ({ ...p }))
  accounts = cfg.accounts.map((a) => ({ ...a }))
  projectRoot = cfg.projectRoot ?? ''
  categories = [...(cfg.categories ?? [])]
}

async function openManager(k: Kind): Promise<void> {
  m?.close()
  kind = k
  filter = ''
  await load()
  m = openModal({
    title: k === 'paths' ? 'Projects' : 'Accounts',
    subtitle:
      k === 'paths'
        ? 'Click a project to open it in a new tab, or type its name in any pane to jump there.'
        : 'Click an account to start it in a new tab, or type its name in any pane.',
    icon: k === 'paths' ? 'projects' : 'accounts',
    className: 'profiles-modal',
    onDismiss: () => (m = null)
  })
  m.body.classList.add('pf-body')

  const importBtn = el('button', 'shortcuts-secondary', `Import from ${profileLabel}`)
  importBtn.addEventListener('click', () => void runImport())
  statusEl = el('div', 'shortcuts-status')
  const done = el('button', 'shortcuts-primary', 'Done')
  done.addEventListener('click', () => {
    m?.close()
    m = null
  })
  m.footer.append(importBtn, statusEl, done)
  renderGrid()
}

// ---------- Saving ----------

function config(): ShortcutsConfig {
  const cfg: ShortcutsConfig = { version: 1, paths, accounts }
  if (projectRoot) cfg.projectRoot = projectRoot
  if (categories.length > 0) cfg.categories = categories
  return cfg
}

/** Save everything. Returns the errors, empty on success. */
async function persistAll(): Promise<string[]> {
  let result: Awaited<ReturnType<typeof window.lightclaude.shortcuts.save>>
  try {
    result = await window.lightclaude.shortcuts.save(config())
  } catch (err) {
    return [`Save failed: ${err instanceof Error ? err.message : String(err)}`]
  }
  if (!result.ok) return result.errors
  const warnings = result.warnings ?? []
  setStatus(warnings.length ? warnings.join(' · ') : 'Saved. New panes have it; open panes: reload the profile.', warnings.length > 0)
  for (const id of result.guides ?? []) {
    toast({
      tone: 'warning',
      title: GUIDES[id].title,
      detail: 'Your shortcuts are saved and work in Light Code panes.',
      action: { label: 'How to fix', run: () => openGuide(id) },
      duration: 12000
    })
  }
  return []
}

function setStatus(text: string, isError = false): void {
  if (!statusEl) return
  statusEl.textContent = text
  statusEl.classList.toggle('error', isError)
}

// ---------- The grid ----------

function initials(name: string): string {
  const parts = name
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .split(/[\s_\-.]+/)
    .filter(Boolean)
  const s = parts.length > 1 ? parts[0]![0]! + parts[1]![0]! : name.slice(0, 2)
  return s.toUpperCase()
}

/** A steady colour per name, from a small flat palette. */
const AVATAR_COLORS = ['#3b82f6', '#8b5cf6', '#ec4899', '#f59e0b', '#10b981', '#06b6d4', '#ef4444', '#84cc16']
function colorFor(name: string): string {
  let h = 0
  for (const ch of name.toLowerCase()) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return AVATAR_COLORS[h % AVATAR_COLORS.length]!
}

const PROVIDER_COLORS: Record<AccountProvider, string> = {
  claude: '#d97757',
  codex: '#10a37f',
  antigravity: '#4285f4'
}

function card(opts: {
  top: string
  name: string
  sub: string
  color: string
  title: string
  onOpen: () => void
  onEdit: () => void
  onDelete: () => void
}): HTMLElement {
  const c = el('div', 'pf-card')
  c.tabIndex = 0
  c.title = opts.title
  c.setAttribute('role', 'button')
  const top = el('div', 'pf-card-top', opts.top)
  const avatar = el('div', 'pf-avatar', initials(opts.name))
  avatar.style.background = opts.color
  const name = el('div', 'pf-card-name', opts.name)
  const sub = el('div', 'pf-card-sub', opts.sub)
  const tools = el('div', 'pf-card-tools')
  const edit = iconBtn('rename', 'Edit')
  const del = iconBtn('close', 'Delete')
  edit.addEventListener('click', (e) => {
    e.stopPropagation()
    opts.onEdit()
  })
  del.addEventListener('click', (e) => {
    e.stopPropagation()
    opts.onDelete()
  })
  tools.append(edit, del)
  c.append(tools, top, avatar, name, sub)
  c.addEventListener('click', opts.onOpen)
  c.addEventListener('keydown', (e) => {
    if (e.target !== c) return
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      opts.onOpen()
    } else if (e.key === 'F2') opts.onEdit()
    else if (e.key === 'Delete') opts.onDelete()
  })
  return c
}

function addCard(label: string, onAdd: () => void): HTMLElement {
  const c = el('button', 'pf-card pf-add')
  const plus = el('div', 'pf-add-circle')
  plus.innerHTML = icon('plus', 22) // constant SVG only
  c.append(el('div', 'pf-card-top', label), plus, el('div', 'pf-card-sub', 'New'))
  c.addEventListener('click', onAdd)
  return c
}

function renderGrid(): void {
  if (!m) return
  m.body.replaceChildren()

  // Toolbar: search, and for accounts the provider filter.
  const bar = el('div', 'pf-bar')
  const search = el('input', 'pf-search')
  search.placeholder = kind === 'paths' ? 'Search projects' : 'Search accounts'
  search.value = filter
  search.spellcheck = false
  bar.appendChild(search)
  if (kind === 'accounts') {
    const seg = el('div', 'pf-seg')
    for (const id of ['all', ...PROVIDER_IDS] as const) {
      const b = el('button', 'pf-seg-btn', id === 'all' ? 'All' : PROVIDERS[id].label)
      b.classList.toggle('on', providerFilter === id)
      b.addEventListener('click', () => {
        providerFilter = id
        renderGrid()
      })
      seg.appendChild(b)
    }
    bar.appendChild(seg)
  } else {
    const setupBtn = el('button', 'btn btn-sm', 'Folder & categories')
    setupBtn.addEventListener('click', () => {
      setupBox.hidden = !setupBox.hidden
    })
    bar.appendChild(setupBtn)
  }
  const addBtn = el('button', 'btn btn-primary btn-sm')
  addBtn.innerHTML = icon('plus', 14) // constant SVG only
  addBtn.append(el('span', undefined, kind === 'paths' ? 'Add project' : 'Add account'))
  addBtn.addEventListener('click', () => (kind === 'paths' ? editProject(null) : editAccount(null)))
  bar.appendChild(addBtn)
  m.body.appendChild(bar)

  const setupBox = el('div', 'shortcuts-setup pf-setup')
  setupBox.hidden = projectRoot !== '' || kind !== 'paths'
  if (kind === 'paths') {
    renderSetup(setupBox)
    m.body.appendChild(setupBox)
  }

  const scroll = el('div', 'pf-scroll')
  m.body.appendChild(scroll)

  const paint = (): void => {
    scroll.replaceChildren()
    const q = filter.trim().toLowerCase()
    if (kind === 'paths') paintProjects(scroll, q)
    else paintAccounts(scroll, q)
  }
  search.addEventListener('input', () => {
    filter = search.value
    paint()
  })
  paint()
}

function paintProjects(scroll: HTMLElement, q: string): void {
  const shown = paths.filter((p) => !q || p.name.toLowerCase().includes(q) || p.path.toLowerCase().includes(q))
  // Grouped by category when there are any; "Other" for the rest.
  const groups = new Map<string, PathShortcut[]>()
  for (const c of categories) groups.set(c, [])
  for (const p of shown) {
    const key = p.category && categories.includes(p.category) ? p.category : ''
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(p)
  }
  if (q && shown.length === 0) {
    scroll.appendChild(el('div', 'shortcuts-empty', 'No project matches.'))
    return
  }
  const grouped = categories.length > 0
  if (!grouped) groups.set('', groups.get('') ?? [])
  for (const [cat, list] of groups) {
    // Empty categories still show while not searching: somewhere to add into.
    // "Other" only when something is in it.
    if (list.length === 0 && (q || (grouped && cat === ''))) continue
    if (grouped) {
      const head = el('div', 'pf-group-head', cat || 'Other')
      head.appendChild(el('span', 'pf-group-count', String(list.length)))
      scroll.appendChild(head)
    }
    const grid = el('div', 'pf-grid')
    for (const p of list) {
      grid.appendChild(
        card({
          top: p.category || 'Project',
          name: p.name,
          sub: p.path,
          color: colorFor(p.name),
          title: `${p.path}\nClick to open in a new tab`,
          onOpen: () => openProject(p),
          onEdit: () => editProject(p),
          onDelete: () => void deleteEntry(p.name)
        })
      )
    }
    grid.appendChild(addCard('Add', () => editProject(null, cat || undefined)))
    scroll.appendChild(grid)
  }
}

function paintAccounts(scroll: HTMLElement, q: string): void {
  const shown = accounts.filter(
    (a) =>
      (providerFilter === 'all' || providerOf(a) === providerFilter) &&
      (!q || a.name.toLowerCase().includes(q) || a.configDir.toLowerCase().includes(q))
  )
  if (q && shown.length === 0) scroll.appendChild(el('div', 'shortcuts-empty', 'No account matches.'))
  const grid = el('div', 'pf-grid')
  for (const a of shown) {
    const p = providerOf(a)
    grid.appendChild(
      card({
        top: PROVIDERS[p].label,
        name: a.name,
        sub: a.configDir,
        color: PROVIDER_COLORS[p],
        title: `${a.configDir}\nClick to start ${PROVIDERS[p].bin} with this account in a new tab`,
        onOpen: () => void startAccount(a),
        onEdit: () => editAccount(a),
        onDelete: () => void deleteEntry(a.name)
      })
    )
  }
  grid.appendChild(addCard('Add', () => editAccount(null, providerFilter === 'all' ? undefined : providerFilter)))
  scroll.appendChild(grid)
}

// ---------- Open ----------

function openProject(p: PathShortcut): void {
  m?.close()
  m = null
  void createTab({ projectPath: p.path, name: p.name })
}

/** A new tab in the current project folder, with the account's shortcut typed in. */
async function startAccount(a: AccountShortcut): Promise<void> {
  m?.close()
  m = null
  const pane: LayoutNode = { type: 'pane', id: newId('p') }
  pendingCommand.set(pane.id, a.name)
  await createTab({
    projectPath: activeTab()?.projectPath || home,
    name: a.name,
    layout: pane
  })
}

async function deleteEntry(name: string): Promise<void> {
  const ok = await confirmDialog(`Delete "${name}"? Its folder and files are kept.`, 'Delete')
  if (!ok) return
  const before = { paths, accounts }
  if (kind === 'paths') paths = paths.filter((p) => p.name !== name)
  else accounts = accounts.filter((a) => a.name !== name)
  const errors = await persistAll()
  if (errors.length) {
    paths = before.paths
    accounts = before.accounts
    setStatus(errors.join(' · '), true)
  } else setStatus(`"${name}" deleted.`)
  renderGrid()
}

// ---------- Editing ----------

interface FieldOpts {
  label: string
  input: HTMLElement
  hint?: string
}

function field(o: FieldOpts): HTMLElement {
  const f = el('label', 'pf-field')
  f.append(el('span', 'pf-field-label', o.label), o.input)
  if (o.hint) f.appendChild(el('span', 'pf-field-hint', o.hint))
  return f
}

/** The editor shared by both kinds. `extra` goes between the name and the folder. */
function editor(opts: {
  heading: string
  name: string
  folder: string
  fresh: boolean
  extra?: HTMLElement[]
  /** The folder a fresh entry gets from its name, or null when there is none. */
  autoFolder: (name: string) => string | null
  folderPlaceholder: string
  onSave: (name: string, folder: string) => Promise<string[]>
}): { refreshAuto: () => void } {
  if (!m) return { refreshAuto: () => {} }
  m.body.replaceChildren()
  const form = el('form', 'pf-form')
  form.appendChild(el('div', 'pf-form-head', opts.heading))

  const name = el('input', 'pf-input')
  name.value = opts.name
  name.placeholder = 'name, e.g. shop or work'
  name.spellcheck = false
  const folder = el('input', 'pf-input')
  folder.value = opts.folder
  folder.placeholder = opts.folderPlaceholder
  folder.spellcheck = false
  let manual = !opts.fresh || opts.folder !== ''
  const refreshAuto = (): void => {
    if (manual) return
    const auto = opts.autoFolder(name.value.trim())
    if (auto !== null) folder.value = auto
  }
  name.addEventListener('input', refreshAuto)
  folder.addEventListener('input', () => {
    manual = folder.value.trim() !== ''
    if (!manual) refreshAuto()
  })
  const pick = el('button', 'btn btn-sm', 'Browse…')
  pick.type = 'button'
  pick.addEventListener('click', () => {
    void window.lightclaude.pickFolder().then((f) => {
      if (f) {
        folder.value = f
        manual = true
      }
    })
  })
  const folderRow = el('div', 'pf-folder-row')
  folderRow.append(folder, pick)

  const error = el('div', 'pf-error')
  form.append(
    field({ label: 'Name', input: name, hint: 'Letters, digits, - and _. This is also the command you type in a pane.' }),
    ...(opts.extra ?? []),
    field({
      label: 'Folder',
      input: folderRow,
      hint: opts.fresh ? 'Filled in from the name; created on save if it does not exist.' : undefined
    }),
    error
  )

  const actions = el('div', 'pf-form-actions')
  const cancel = el('button', 'btn', 'Cancel')
  cancel.type = 'button'
  cancel.addEventListener('click', renderGrid)
  const save = el('button', 'btn btn-primary', 'Save')
  save.type = 'submit'
  actions.append(cancel, save)
  form.appendChild(actions)
  form.addEventListener('submit', (e) => {
    e.preventDefault()
    const n = name.value.trim()
    const f = folder.value.trim()
    if (!n) {
      error.textContent = 'Give it a name.'
      name.focus()
      return
    }
    if (!f) {
      error.textContent = 'Choose a folder.'
      folder.focus()
      return
    }
    save.disabled = true
    void opts.onSave(n, f).then((errors) => {
      save.disabled = false
      if (errors.length) error.textContent = errors.join(' · ')
      else renderGrid()
    })
  })
  m.body.appendChild(form)
  refreshAuto()
  name.focus()
  return { refreshAuto }
}

/** Replace `old` (or append) in `list`, save, and undo on failure. */
async function commit<T>(list: T[], setList: (l: T[]) => void, old: T | null, next: T): Promise<string[]> {
  const before = list
  const updated = old ? list.map((x) => (x === old ? next : x)) : [...list, next]
  setList(updated)
  const errors = await persistAll()
  if (errors.length) setList(before)
  return errors
}

function editProject(p: PathShortcut | null, presetCategory?: string): void {
  let category = p?.category ?? presetCategory ?? ''
  const extra: HTMLElement[] = []
  let ed: { refreshAuto: () => void } | null = null
  if (categories.length > 0) {
    const select = el('select', 'pf-input')
    for (const c of ['', ...categories, ...(category && !categories.includes(category) ? [category] : [])]) {
      const o = el('option', undefined, c || 'None')
      o.value = c
      select.appendChild(o)
    }
    select.value = category
    select.addEventListener('change', () => {
      category = select.value
      ed?.refreshAuto()
    })
    extra.push(
      field({
        label: 'Category',
        input: select,
        hint: p ? 'Moving a saved project to another category does not move its folder.' : 'Also the sub-folder it is created in.'
      })
    )
  }
  ed = editor({
    heading: p ? `Edit ${p.name}` : 'New project',
    name: p?.name ?? '',
    folder: p?.path ?? '',
    fresh: !p,
    extra,
    autoFolder: (n) => (n && projectRoot ? projectTarget(projectRoot, category || undefined, n, sep) : null),
    folderPlaceholder: projectRoot ? 'type a name, the folder fills in' : 'C:\\path\\to\\project',
    onSave: (name, folder) => {
      const next: PathShortcut = { name, path: folder }
      if (category) next.category = category
      return commit(paths, (l) => (paths = l), p, next)
    }
  })
}

function editAccount(a: AccountShortcut | null, presetProvider?: AccountProvider): void {
  let provider: AccountProvider = a ? providerOf(a) : (presetProvider ?? 'claude')
  let ed: { refreshAuto: () => void } | null = null
  const seg = el('div', 'pf-seg pf-provider')
  const note = el('span', 'pf-field-hint')
  const paintSeg = (): void => {
    for (const b of seg.children) b.classList.toggle('on', (b as HTMLElement).dataset['id'] === provider)
    note.textContent = PROVIDERS[provider].note
  }
  for (const id of PROVIDER_IDS) {
    const b = el('button', 'pf-seg-btn')
    b.type = 'button'
    b.dataset['id'] = id
    const dot = el('span', 'pf-dot')
    dot.style.background = PROVIDER_COLORS[id]
    b.append(dot, el('span', undefined, PROVIDERS[id].label))
    b.addEventListener('click', () => {
      provider = id
      paintSeg()
      ed?.refreshAuto()
    })
    seg.appendChild(b)
  }
  paintSeg()
  const providerField = el('div', 'pf-field')
  providerField.append(el('span', 'pf-field-label', 'Agent'), seg, note)

  ed = editor({
    heading: a ? `Edit ${a.name}` : 'New account',
    name: a?.name ?? '',
    folder: a?.configDir ?? '',
    fresh: !a,
    extra: [providerField],
    autoFolder: (n) => (n && home ? accountTarget(home, n, sep, PROVIDERS[provider].dirPrefix) : null),
    folderPlaceholder: isWin ? 'C:\\Users\\you\\.claude-work' : '~/.claude-work',
    onSave: (name, folder) => {
      const next: AccountShortcut = { name, configDir: folder }
      if (provider !== 'claude') next.provider = provider
      return commit(accounts, (l) => (accounts = l), a, next)
    }
  })
}

// ---------- Main folder & categories (projects) ----------

function renderSetup(box: HTMLElement): void {
  box.replaceChildren()
  const rootLine = el('div', 'shortcuts-setup-line')
  const rootPath = el('span', 'shortcuts-setup-path', projectRoot || 'Not set: new projects need a folder chosen by hand')
  rootPath.classList.toggle('muted', !projectRoot)
  rootPath.title = projectRoot
  const choose = el('button', 'shortcuts-secondary', projectRoot ? 'Change…' : 'Choose…')
  choose.addEventListener('click', () => void chooseRoot())
  rootLine.append(el('span', 'shortcuts-setup-label', 'Main folder'), rootPath, choose)
  if (projectRoot) {
    const clear = iconBtn('close', 'Stop using a main folder', 'shortcuts-icon-btn')
    clear.addEventListener('click', () => {
      projectRoot = ''
      void persistAll().then(() => renderSetup(box))
    })
    rootLine.appendChild(clear)
  }
  box.appendChild(rootLine)

  const catLine = el('div', 'shortcuts-setup-line')
  const chips = el('div', 'shortcuts-chips')
  for (const c of categories) {
    const used = paths.filter((r) => r.category === c).length
    const chip = el('span', 'shortcuts-chip', used ? `${c} · ${used}` : c)
    const x = el('button', undefined, '×')
    x.title = `Remove category "${c}"`
    x.addEventListener('click', () => {
      if (used > 0) {
        setStatus(`"${c}" still has ${used} project(s), move them to another category first.`, true)
        return
      }
      categories = categories.filter((k) => k !== c)
      void persistAll().then(renderGrid)
    })
    chip.appendChild(x)
    chips.appendChild(chip)
  }
  const input = el('input', 'shortcuts-cat-input')
  input.placeholder = '+ category'
  input.spellcheck = false
  const add = (): void => {
    const name = input.value.trim()
    if (!name) return
    if (!isValidCategory(name)) {
      setStatus(`"${name}" can't be a folder name (no \\ / : * ? " < > |, no trailing dot or space).`, true)
      return
    }
    if (categories.some((c) => c.toLowerCase() === name.toLowerCase())) {
      setStatus(`Category "${name}" already exists.`, true)
      return
    }
    categories.push(name)
    void persistAll().then(() => {
      renderGrid()
      const again = m?.body.querySelector<HTMLElement>('.pf-setup')
      if (again) again.hidden = false
      m?.body.querySelector<HTMLInputElement>('.shortcuts-cat-input')?.focus()
    })
  }
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      add()
    }
  })
  chips.appendChild(input)
  catLine.append(el('span', 'shortcuts-setup-label', 'Categories'), chips)
  box.appendChild(catLine)
}

async function chooseRoot(): Promise<void> {
  const folder = await window.lightclaude.pickFolder()
  if (!folder) return
  projectRoot = folder
  // Projects already laid out as <root>\<category>\<name> teach their categories.
  let learned = 0
  paths = paths.map((p) => {
    if (p.category || !isInside(projectRoot, p.path, isWin)) return p
    const rel = p.path.slice(projectRoot.replace(/[\\/]+$/, '').length + 1)
    const parts = rel.split(/[\\/]+/).filter(Boolean)
    if (parts.length !== 2 || !isValidCategory(parts[0]!)) return p
    const known = categories.find((c) => c.toLowerCase() === parts[0]!.toLowerCase())
    if (!known) categories.push(parts[0]!)
    learned++
    return { ...p, category: known ?? parts[0]! }
  })
  const errors = await persistAll()
  if (errors.length) setStatus(errors.join(' · '), true)
  else if (learned) setStatus(`Main folder set. ${learned} project(s) sorted into categories from their folders.`)
  renderGrid()
  const again = m?.body.querySelector<HTMLElement>('.pf-setup')
  if (again) again.hidden = false
}

// ---------- Import ----------

async function runImport(): Promise<void> {
  let result: Awaited<ReturnType<typeof window.lightclaude.shortcuts.importFromProfile>>
  try {
    result = await window.lightclaude.shortcuts.importFromProfile()
  } catch (err) {
    setStatus(`Import failed: ${err instanceof Error ? err.message : String(err)}`, true)
    return
  }
  const known = new Set((kind === 'paths' ? paths : accounts).map((r) => r.name.toLowerCase()))
  let added = 0
  if (kind === 'paths') {
    for (const p of result.paths) {
      if (known.has(p.name.toLowerCase())) continue
      paths.push(p)
      known.add(p.name.toLowerCase())
      added++
    }
  } else {
    for (const a of result.accounts) {
      if (known.has(a.name.toLowerCase())) continue
      accounts.push(a)
      known.add(a.name.toLowerCase())
      added++
    }
  }
  if (added > 0) {
    const errors = await persistAll()
    if (errors.length) {
      await load()
      setStatus(errors.join(' · '), true)
    } else setStatus(`${added} imported from ${profileLabel}.`)
    renderGrid()
    return
  }
  const unreadable = result.unreadable ?? []
  if (unreadable.length > 0) setStatus(`Could not read ${unreadable.join(' · ')}`, true)
  else
    setStatus(
      result.found === 0 ? `There is no ${profileLabel} on this computer yet, so there is nothing to import.` : `No new entries found in ${profileLabel}.`
    )
}
