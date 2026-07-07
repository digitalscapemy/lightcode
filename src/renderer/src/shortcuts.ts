import type { AccountShortcut, PathShortcut, ShortcutsConfig } from '../../shared/types'
import { panes } from './app'
import { state } from './store'

type Kind = 'paths' | 'accounts'

interface Row {
  name: string
  target: string
}

let overlay: HTMLElement | null = null
let activeKind: Kind = 'paths'
let pathRows: Row[] = []
let accountRows: Row[] = []
let statusEl: HTMLElement
let activeListEl: HTMLElement

const isWin = window.lightclaude.platform === 'win32'
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
  const cfg = await window.lightclaude.shortcuts.load()
  pathRows = cfg.paths.map((p) => ({ name: p.name, target: p.path }))
  accountRows = cfg.accounts.map((a) => ({ name: a.name, target: a.configDir }))

  buildModal()

  // Nothing saved yet for this section: prefill from the user's profile.
  if (activeRows().length === 0) await runImport(true)
}

function activeRows(): Row[] {
  return activeKind === 'paths' ? pathRows : accountRows
}

function buildModal(): void {
  const meta = KIND_META[activeKind]

  overlay = document.createElement('div')
  overlay.id = 'shortcuts-overlay'
  overlay.addEventListener('pointerdown', (e) => {
    if (e.target === overlay) closeModal()
  })

  const modal = document.createElement('div')
  modal.className = 'shortcuts-modal'
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

  const wrap = document.createElement('div')
  wrap.className = 'shortcuts-section'
  const head = document.createElement('div')
  head.className = 'shortcuts-section-head'
  const hintEl = document.createElement('div')
  hintEl.className = 'shortcuts-hint'
  hintEl.textContent = meta.hint
  const add = document.createElement('button')
  add.className = 'shortcuts-secondary'
  add.textContent = '+ Add'
  head.append(hintEl, add)
  activeListEl = document.createElement('div')
  activeListEl.className = 'shortcuts-list'
  wrap.append(head, activeListEl)
  body.appendChild(wrap)

  add.addEventListener('click', () => {
    activeRows().push({ name: '', target: '' })
    renderRows()
    activeListEl.querySelector<HTMLInputElement>('.shortcuts-row:last-child input')?.focus()
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
  if (state.focusedPaneId) panes.get(state.focusedPaneId)?.focus()
}

function renderRows(): void {
  const rows = activeRows()
  const { targetKind } = KIND_META[activeKind]
  activeListEl.textContent = ''
  if (rows.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'shortcuts-empty'
    empty.textContent = '— no entries —'
    activeListEl.appendChild(empty)
    return
  }
  rows.forEach((row, i) => {
    const rowEl = document.createElement('div')
    rowEl.className = 'shortcuts-row'

    const name = document.createElement('input')
    name.className = 'shortcuts-name'
    name.placeholder = 'name'
    name.value = row.name
    name.spellcheck = false
    name.addEventListener('input', () => {
      row.name = name.value.trim()
      name.classList.remove('invalid')
    })

    const target = document.createElement('input')
    target.className = 'shortcuts-target'
    target.placeholder =
      targetKind === 'folder' ? 'C:\\path\\to\\project' : 'C:\\Users\\...\\.claude-1'
    target.value = row.target
    target.spellcheck = false
    target.addEventListener('input', () => {
      row.target = target.value.trim()
      target.classList.remove('invalid')
    })

    const pick = document.createElement('button')
    pick.className = 'shortcuts-icon-btn'
    pick.textContent = '📁'
    pick.title = 'Pick folder'
    pick.addEventListener('click', () => {
      void window.lightclaude.pickFolder().then((folder) => {
        if (folder) {
          row.target = folder
          target.value = folder
          target.classList.remove('invalid')
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
    })

    rowEl.append(name, target, pick, del)
    activeListEl.appendChild(rowEl)
  })
}

/** Import entries of the ACTIVE kind only; the other section stays as loaded. */
async function runImport(silentIfEmpty: boolean): Promise<void> {
  const result = await window.lightclaude.shortcuts.importFromProfile()
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
  if (added > 0) {
    setStatus(`${added} imported from ${profileLabel} — press Save to keep them.`, false)
  } else if (!silentIfEmpty) {
    setStatus(`No new entries found in ${profileLabel}.`, false)
  }
}

async function save(): Promise<void> {
  const cfg: ShortcutsConfig = {
    version: 1,
    paths: pathRows
      .filter((r) => r.name || r.target)
      .map((r): PathShortcut => ({ name: r.name, path: r.target })),
    accounts: accountRows
      .filter((r) => r.name || r.target)
      .map((r): AccountShortcut => ({ name: r.name, configDir: r.target }))
  }
  const result = await window.lightclaude.shortcuts.save(cfg)
  if (result.ok) {
    setStatus(`Saved ✓ — new panes get these automatically; existing panes: run ${reloadHint}`, false)
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
