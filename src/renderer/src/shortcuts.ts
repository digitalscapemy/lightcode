import {
  accountTarget,
  isInside,
  isValidCategory,
  projectTarget
} from '../../shared/shortcutPaths'
import type { AccountShortcut, PathShortcut, ShortcutsConfig } from '../../shared/types'
import { panes } from './app'
import { state } from './store'

type Kind = 'paths' | 'accounts'

interface Row {
  name: string
  target: string
  category?: string
  /** Added in this session and not saved yet: its folder can still follow the name. */
  fresh?: boolean
  /** The user typed the target by hand — stop filling it in. */
  manual?: boolean
}

let overlay: HTMLElement | null = null
let activeKind: Kind = 'paths'
let pathRows: Row[] = []
let accountRows: Row[] = []
let projectRoot = ''
let categories: string[] = []
let lastCategory = ''
let home = ''
let statusEl: HTMLElement
let activeListEl: HTMLElement
let setupEl: HTMLElement | null = null

const isWin = window.lightclaude.platform === 'win32'
const sep = isWin ? '\\' : '/'
const profileLabel = isWin ? '$PROFILE' : '~/.zshrc'
const reloadHint = isWin ? '`. $PROFILE`' : '`source ~/.zshrc`'

const KIND_META: Record<Kind, { title: string; hint: string; targetKind: 'folder' | 'config dir' }> =
  {
    paths: {
      title: 'Project Shortcuts',
      hint: 'Type the name in a terminal to cd straight into the project folder.',
      targetKind: 'folder'
    },
    accounts: {
      title: 'Claude Accounts',
      hint: "Type the name to run claude with that account's CLAUDE_CONFIG_DIR.",
      targetKind: 'config dir'
    }
  }

export function initShortcutsUi(): void {
  document.getElementById('projects-btn')!.addEventListener('click', () => void openModal('paths'))
  document
    .getElementById('accounts-btn')!
    .addEventListener('click', () => void openModal('accounts'))
}

async function openModal(kind: Kind): Promise<void> {
  if (overlay) closeModal()
  activeKind = kind
  const [cfg, homeDir] = await Promise.all([
    window.lightclaude.shortcuts.load(),
    window.lightclaude.homedir()
  ])
  home = homeDir
  pathRows = cfg.paths.map((p) => ({ name: p.name, target: p.path, category: p.category }))
  accountRows = cfg.accounts.map((a) => ({ name: a.name, target: a.configDir }))
  projectRoot = cfg.projectRoot ?? ''
  categories = [...(cfg.categories ?? [])]

  buildModal()

  // Nothing saved yet for this section: prefill from the user's profile.
  if (activeRows().length === 0) await runImport(true)
}

function activeRows(): Row[] {
  return activeKind === 'paths' ? pathRows : accountRows
}

/** Where a fresh row's folder goes, or null when there is nothing to build it from. */
function autoTarget(row: Row): string | null {
  if (!row.name) return ''
  if (activeKind === 'paths') {
    return projectRoot ? projectTarget(projectRoot, row.category, row.name, sep) : null
  }
  return home ? accountTarget(home, row.name, sep) : null
}

function isAuto(row: Row): boolean {
  return !!row.fresh && !row.manual && autoTarget(row) !== null
}

function buildModal(): void {
  const meta = KIND_META[activeKind]

  overlay = document.createElement('div')
  overlay.id = 'shortcuts-overlay'
  overlay.addEventListener('pointerdown', (e) => {
    if (e.target === overlay) closeModal()
  })

  const modal = document.createElement('div')
  modal.className = 'shortcuts-modal shortcuts-manager'
  overlay.appendChild(modal)

  const header = document.createElement('div')
  header.className = 'shortcuts-header'
  const title = document.createElement('span')
  title.textContent = meta.title
  const closeBtn = document.createElement('button')
  closeBtn.className = 'shortcuts-close'
  closeBtn.textContent = '×'
  closeBtn.addEventListener('click', closeModal)
  header.append(title, closeBtn)
  modal.appendChild(header)

  const body = document.createElement('div')
  body.className = 'shortcuts-body'
  modal.appendChild(body)

  if (activeKind === 'paths') {
    setupEl = document.createElement('div')
    setupEl.className = 'shortcuts-setup'
    body.appendChild(setupEl)
  } else {
    setupEl = null
  }

  const wrap = document.createElement('div')
  wrap.className = 'shortcuts-section'
  const head = document.createElement('div')
  head.className = 'shortcuts-section-head'
  const hintEl = document.createElement('div')
  hintEl.className = 'shortcuts-hint'
  hintEl.textContent =
    activeKind === 'accounts'
      ? `${meta.hint} New accounts get ~${sep}.claude-<name>, created on Save.`
      : meta.hint
  const add = document.createElement('button')
  add.className = 'shortcuts-secondary'
  add.textContent = '+ Add'
  head.append(hintEl, add)
  activeListEl = document.createElement('div')
  activeListEl.className = 'shortcuts-list'
  wrap.append(head, activeListEl)
  body.appendChild(wrap)

  add.addEventListener('click', () => {
    const row: Row = { name: '', target: '', fresh: true }
    if (activeKind === 'paths' && categories.includes(lastCategory)) row.category = lastCategory
    activeRows().push(row)
    renderRows()
    const last = activeListEl.querySelector<HTMLInputElement>('.shortcuts-row:last-child input')
    last?.focus()
    last?.scrollIntoView({ block: 'nearest' })
  })

  const footer = document.createElement('div')
  footer.className = 'shortcuts-footer'
  const importBtn = document.createElement('button')
  importBtn.className = 'shortcuts-secondary'
  importBtn.textContent = `Import from ${profileLabel}`
  importBtn.addEventListener('click', () => void runImport(false))
  statusEl = document.createElement('div')
  statusEl.className = 'shortcuts-status'
  const saveBtn = document.createElement('button')
  saveBtn.className = 'shortcuts-primary'
  saveBtn.textContent = 'Save'
  saveBtn.addEventListener('click', () => void save())
  footer.append(importBtn, statusEl, saveBtn)
  modal.appendChild(footer)

  document.addEventListener('keydown', onKeydown, { capture: true })
  document.body.appendChild(overlay)
  renderSetup()
  renderRows()
}

/** Main folder + categories bar (projects only). Entirely optional. */
function renderSetup(): void {
  if (!setupEl) return
  setupEl.textContent = ''

  const rootLine = document.createElement('div')
  rootLine.className = 'shortcuts-setup-line'
  const rootLabel = document.createElement('span')
  rootLabel.className = 'shortcuts-setup-label'
  rootLabel.textContent = 'Main folder'
  const rootPath = document.createElement('span')
  rootPath.className = 'shortcuts-setup-path'
  rootPath.textContent = projectRoot || 'not set, new projects need a path typed in by hand'
  rootPath.classList.toggle('muted', !projectRoot)
  rootPath.title = projectRoot
  const choose = document.createElement('button')
  choose.className = 'shortcuts-secondary'
  choose.textContent = projectRoot ? 'Change…' : 'Choose…'
  choose.addEventListener('click', () => void chooseRoot())
  rootLine.append(rootLabel, rootPath, choose)
  if (projectRoot) {
    const clear = document.createElement('button')
    clear.className = 'shortcuts-icon-btn'
    clear.textContent = '×'
    clear.title = 'Stop using a main folder'
    clear.addEventListener('click', () => {
      projectRoot = ''
      renderSetup()
      renderRows()
    })
    rootLine.appendChild(clear)
  }
  setupEl.appendChild(rootLine)

  const catLine = document.createElement('div')
  catLine.className = 'shortcuts-setup-line'
  const catLabel = document.createElement('span')
  catLabel.className = 'shortcuts-setup-label'
  catLabel.textContent = 'Categories'
  const chips = document.createElement('div')
  chips.className = 'shortcuts-chips'
  for (const c of categories) {
    const chip = document.createElement('span')
    chip.className = 'shortcuts-chip'
    const used = pathRows.filter((r) => r.category === c).length
    chip.textContent = used ? `${c} · ${used}` : c
    const x = document.createElement('button')
    x.textContent = '×'
    x.title = `Remove category "${c}"`
    x.addEventListener('click', () => removeCategory(c))
    chip.appendChild(x)
    chips.appendChild(chip)
  }
  const input = document.createElement('input')
  input.className = 'shortcuts-cat-input'
  input.placeholder = '+ category'
  input.spellcheck = false
  const addCat = (): void => {
    if (addCategory(input.value.trim())) input.value = ''
  }
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      addCat()
    }
  })
  input.addEventListener('blur', () => {
    if (input.value.trim()) addCat()
  })
  chips.appendChild(input)
  catLine.append(catLabel, chips)
  setupEl.appendChild(catLine)
}

async function chooseRoot(): Promise<void> {
  const folder = await window.lightclaude.pickFolder()
  if (!folder) return
  projectRoot = folder
  // Existing projects already laid out as <root>\<category>\<name> teach us
  // their categories, so the first setup is not a blank slate.
  let learned = 0
  for (const row of pathRows) {
    if (row.category || !isInside(projectRoot, row.target, isWin)) continue
    const rel = row.target.slice(projectRoot.replace(/[\\/]+$/, '').length + 1)
    const parts = rel.split(/[\\/]+/).filter(Boolean)
    if (parts.length !== 2 || !isValidCategory(parts[0])) continue
    const known = categories.find((c) => c.toLowerCase() === parts[0].toLowerCase())
    if (!known) categories.push(parts[0])
    row.category = known ?? parts[0]
    learned++
  }
  renderSetup()
  renderRows()
  setStatus(
    learned
      ? `Main folder set. ${learned} project(s) sorted into categories from their folders, press Save to keep.`
      : 'Main folder set, press Save to keep it.',
    false
  )
}

function addCategory(name: string): boolean {
  if (!name) return false
  if (!isValidCategory(name)) {
    setStatus(`"${name}" can't be a folder name (no \\ / : * ? " < > |, no trailing dot or space).`, true)
    return false
  }
  if (categories.some((c) => c.toLowerCase() === name.toLowerCase())) {
    setStatus(`Category "${name}" already exists.`, true)
    return false
  }
  categories.push(name)
  lastCategory = name
  renderSetup()
  renderRows()
  setStatus(`Category "${name}" added, press Save to keep it.`, false)
  setupEl?.querySelector<HTMLInputElement>('.shortcuts-cat-input')?.focus()
  return true
}

function removeCategory(name: string): void {
  const used = pathRows.filter((r) => r.category === name).length
  if (used > 0) {
    setStatus(`"${name}" still has ${used} project(s), move them to another category first.`, true)
    return
  }
  categories = categories.filter((c) => c !== name)
  renderSetup()
  renderRows()
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    e.stopPropagation()
    closeModal()
  }
}

function closeModal(): void {
  document.removeEventListener('keydown', onKeydown, { capture: true })
  overlay?.remove()
  overlay = null
  setupEl = null
  if (state.focusedPaneId) panes.get(state.focusedPaneId)?.focus()
}

function renderRows(): void {
  const rows = activeRows()
  const { targetKind } = KIND_META[activeKind]
  const showCategory = activeKind === 'paths' && categories.length > 0
  activeListEl.textContent = ''
  if (rows.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'shortcuts-empty'
    empty.textContent = 'No entries yet'
    activeListEl.appendChild(empty)
    return
  }
  rows.forEach((row, i) => {
    const rowEl = document.createElement('div')
    rowEl.className = 'shortcuts-row'

    const target = document.createElement('input')
    target.className = 'shortcuts-target'
    target.spellcheck = false

    /** Fill in the folder for a fresh row; leave saved/hand-typed ones alone. */
    const syncTarget = (): void => {
      const auto = isAuto(row)
      if (auto) {
        row.target = autoTarget(row) ?? ''
        target.value = row.target
      }
      target.classList.toggle('auto', auto)
      target.title = auto ? 'Filled in from the name, the folder is created on Save' : ''
    }

    const name = document.createElement('input')
    name.className = 'shortcuts-name'
    name.placeholder = 'name'
    name.value = row.name
    name.spellcheck = false
    name.addEventListener('input', () => {
      row.name = name.value.trim()
      name.classList.remove('invalid')
      syncTarget()
    })

    target.placeholder =
      activeKind === 'paths' && projectRoot
        ? 'type a name, the folder fills in'
        : targetKind === 'folder'
          ? 'C:\\path\\to\\project'
          : 'C:\\Users\\...\\.claude-1'
    target.value = row.target
    target.addEventListener('input', () => {
      row.target = target.value.trim()
      // Clearing the box hands it back to the automatic path.
      row.manual = row.target !== ''
      target.classList.remove('invalid')
      if (!row.manual) syncTarget()
      else target.classList.remove('auto')
    })

    const pick = document.createElement('button')
    pick.className = 'shortcuts-icon-btn'
    pick.textContent = '📁'
    pick.title = 'Pick folder'
    pick.addEventListener('click', () => {
      void window.lightclaude.pickFolder().then((folder) => {
        if (folder) {
          row.target = folder
          row.manual = true
          target.value = folder
          target.classList.remove('invalid', 'auto')
        }
      })
    })

    const del = document.createElement('button')
    del.className = 'shortcuts-icon-btn'
    del.textContent = '×'
    del.title = 'Delete'
    del.addEventListener('click', () => {
      rows.splice(i, 1)
      renderRows()
      if (activeKind === 'paths') renderSetup() // chip counts
    })

    rowEl.appendChild(name)
    if (showCategory) {
      const select = document.createElement('select')
      select.className = 'shortcuts-category'
      const opts = ['', ...categories]
      if (row.category && !categories.includes(row.category)) opts.push(row.category)
      for (const c of opts) {
        const o = document.createElement('option')
        o.value = c
        o.textContent = c || 'None'
        select.appendChild(o)
      }
      select.value = row.category ?? ''
      select.title = row.fresh
        ? 'Category, also the sub-folder the project goes in'
        : 'Category (the folder of a saved project does not move)'
      select.addEventListener('change', () => {
        row.category = select.value || undefined
        if (row.category) lastCategory = row.category
        syncTarget()
        renderSetup() // chip counts
      })
      rowEl.appendChild(select)
    }
    rowEl.append(target, pick, del)
    activeListEl.appendChild(rowEl)
    syncTarget()
  })
}

/** Import entries of the ACTIVE kind only; the other section stays as loaded. */
async function runImport(silentIfEmpty: boolean): Promise<void> {
  let result: Awaited<ReturnType<typeof window.lightclaude.shortcuts.importFromProfile>>
  try {
    result = await window.lightclaude.shortcuts.importFromProfile()
  } catch (err) {
    setStatus(`Import failed: ${err instanceof Error ? err.message : String(err)}`, true)
    return
  }
  const rows = activeRows()
  const known = new Set(rows.map((r) => r.name.toLowerCase()).filter(Boolean))
  const incoming =
    activeKind === 'paths'
      ? result.paths.map((p) => ({ name: p.name, target: p.path }))
      : result.accounts.map((a) => ({ name: a.name, target: a.configDir }))
  let added = 0
  for (const entry of incoming) {
    if (known.has(entry.name.toLowerCase())) continue
    rows.push(entry)
    known.add(entry.name.toLowerCase())
    added++
  }
  renderRows()
  const unreadable = result.unreadable ?? []
  if (added > 0) {
    setStatus(`${added} imported from ${profileLabel}. Press Save to keep them.`, false)
  } else if (unreadable.length > 0) {
    setStatus(`Could not read ${unreadable.join(' · ')}`, true)
  } else if (!silentIfEmpty) {
    // A fresh install has no profile at all: say that, rather than implying
    // the import looked and failed.
    setStatus(
      result.found === 0
        ? `There is no ${profileLabel} on this computer yet, so there is nothing to import, add shortcuts here and press Save.`
        : `No new entries found in ${profileLabel}.`,
      false
    )
  }
}

async function save(): Promise<void> {
  const cfg: ShortcutsConfig = {
    version: 1,
    paths: pathRows
      .filter((r) => r.name || r.target)
      .map((r): PathShortcut => {
        const p: PathShortcut = { name: r.name, path: r.target }
        if (r.category) p.category = r.category
        return p
      }),
    accounts: accountRows
      .filter((r) => r.name || r.target)
      .map((r): AccountShortcut => ({ name: r.name, configDir: r.target }))
  }
  if (projectRoot) cfg.projectRoot = projectRoot
  if (categories.length > 0) cfg.categories = categories
  let result: Awaited<ReturnType<typeof window.lightclaude.shortcuts.save>>
  try {
    result = await window.lightclaude.shortcuts.save(cfg)
  } catch (err) {
    // Never a silent save: whatever went wrong, the person sees it.
    setStatus(`Save failed: ${err instanceof Error ? err.message : String(err)}`, true)
    return
  }
  if (result.ok) {
    // Saved rows keep their folder from now on, whatever the name becomes.
    for (const r of [...pathRows, ...accountRows]) r.fresh = false
    renderRows()
    const created = result.created?.length ?? 0
    const parts = [`Saved ✓`]
    if (created) parts.push(`${created} folder${created === 1 ? '' : 's'} created`)
    parts.push(`new panes get these automatically; existing panes: run ${reloadHint}`)
    const warnings = result.warnings ?? []
    setStatus([parts.join(' · '), ...warnings].join(' · '), warnings.length > 0)
  } else {
    setStatus(result.errors.join(' · '), true)
    markInvalid(result.errors)
  }
}

function setStatus(text: string, isError: boolean): void {
  statusEl.textContent = text
  statusEl.classList.toggle('error', isError)
}

/** Highlight rows whose names appear in validation errors. */
function markInvalid(errors: string[]): void {
  const bad = new Set<string>()
  for (const err of errors) {
    const m = /^"([^"]*)":/.exec(err)
    if (m) bad.add(m[1].toLowerCase())
  }
  for (const input of document.querySelectorAll<HTMLInputElement>('.shortcuts-name')) {
    if (bad.has(input.value.trim().toLowerCase())) input.classList.add('invalid')
  }
}
