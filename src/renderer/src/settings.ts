import { adjustFontSize } from './app'
import { setGitAutoFetch } from './gitTree'
import { buildInstallSection, disposeWhenGone } from './setup'
import { FONT_SIZE_DEFAULT, state } from './store'
import { icon, type IconName } from './ui/icons'
import { openModal } from './ui/modal'
import { PROVIDERS, providerOf } from '../../shared/accountProviders'

/**
 * Settings: every setting the app has, in one place, plus the installation
 * details. Nothing here is new behaviour: each control calls exactly what its
 * other way in already calls (the git panel's chip, Ctrl +/-, Mission
 * Control's switch), so the two can never disagree.
 */

type SectionId = 'general' | 'install' | 'shortcuts' | 'about'

const SECTIONS: { id: SectionId; label: string; icon: IconName }[] = [
  { id: 'general', label: 'General', icon: 'settings' },
  { id: 'install', label: 'Installation', icon: 'sparkle' },
  { id: 'shortcuts', label: 'Projects & accounts', icon: 'projects' },
  { id: 'about', label: 'About', icon: 'info' }
]

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text !== undefined) e.textContent = text
  return e
}

/** One setting: its name and a line on what it does, with the control on the right. */
function settingRow(title: string, detail: string, control: HTMLElement): HTMLElement {
  const row = el('div', 'set-row')
  const text = el('div', 'set-text')
  text.append(el('div', 'set-title', title), el('div', 'set-detail', detail))
  row.append(text, control)
  return row
}

/** A flat on/off switch. `onChange` returns the state that actually took. */
function toggle(initial: boolean, onChange: (on: boolean) => Promise<boolean> | boolean): HTMLButtonElement {
  const b = el('button', 'set-switch')
  b.setAttribute('role', 'switch')
  const paint = (on: boolean): void => {
    b.classList.toggle('on', on)
    b.setAttribute('aria-checked', String(on))
  }
  paint(initial)
  b.addEventListener('click', () => {
    const next = !b.classList.contains('on')
    void Promise.resolve(onChange(next)).then(paint)
  })
  return b
}

function generalSection(): HTMLElement {
  const box = el('div', 'set-section')

  // Terminal text size: the same steps as Ctrl + / Ctrl - / Ctrl 0.
  const size = el('div', 'set-stepper')
  const value = el('span', 'set-value')
  const paint = (): void => {
    value.textContent = `${state.fontSize}px`
  }
  const step = (label: string, delta: number, tip: string): HTMLButtonElement => {
    const b = el('button', 'btn btn-sm', label)
    b.title = tip
    b.addEventListener('click', () => {
      adjustFontSize(delta)
      paint()
    })
    return b
  }
  paint()
  size.append(step('-', -1, 'Smaller'), value, step('+', 1, 'Larger'), step('Reset', 0, `Back to ${FONT_SIZE_DEFAULT}px`))
  box.appendChild(settingRow('Terminal text size', 'Applies to every pane. Ctrl + and Ctrl - do the same.', size))

  box.appendChild(
    settingRow(
      'Fetch git remotes automatically',
      'While the worktree panel is open, it fetches every few minutes so "in sync" is current. Only ever reads the remote.',
      toggle(state.gitAutoFetch, (on) => {
        setGitAutoFetch(on)
        return on
      })
    )
  )

  const lc = toggle(false, async (on) => {
    try {
      return (await window.lightclaude.lc.setEnabled(on)).enabled
    } catch {
      return !on
    }
  })
  void window.lightclaude.lc.state().then((s) => {
    lc.classList.toggle('on', s.enabled)
    lc.setAttribute('aria-checked', String(s.enabled))
  })
  box.appendChild(
    settingRow(
      'Agent CLI (lc)',
      'Lets an agent run `lc` to drive other panes, as the Orchestra does. Panes it drives are marked. Off means nothing is listening.',
      lc
    )
  )
  return box
}

function installSection(): { el: HTMLElement; dispose: () => void } {
  const box = el('div', 'set-section')
  const install = buildInstallSection()
  const again = el('button', 'btn btn-sm', 'Check again')
  again.addEventListener('click', install.recheck)
  const head = el('div', 'set-section-actions')
  head.appendChild(again)
  box.append(head, install.el)
  return { el: box, dispose: install.dispose }
}

function shortcutsSection(close: () => void): HTMLElement {
  const box = el('div', 'set-section')
  const projects = el('span', 'set-value', '…')
  const accounts = el('span', 'set-value', '…')
  const root = el('span', 'set-path', '…')
  void window.lightclaude.shortcuts.load().then((cfg) => {
    projects.textContent = String(cfg.paths.length)
    const counts = Object.values(PROVIDERS)
      .map((p) => ({ p, n: cfg.accounts.filter((a) => providerOf(a) === p.id).length }))
      .filter((x) => x.n > 0)
      .map((x) => `${x.n} ${x.p.label}`)
    accounts.textContent = counts.length ? counts.join(' · ') : 'None yet'
    root.textContent = cfg.projectRoot || 'Not set'
    root.title = cfg.projectRoot ?? ''
  })
  const open = (id: string, label: string): HTMLButtonElement => {
    const b = el('button', 'btn btn-sm', label)
    b.addEventListener('click', () => {
      close()
      document.getElementById(id)?.click()
    })
    return b
  }
  const withValue = (v: HTMLElement, b: HTMLElement): HTMLElement => {
    const w = el('div', 'set-stepper')
    w.append(v, b)
    return w
  }
  box.append(
    settingRow('Projects', 'Folders you open with one click, or by typing their name in any pane.', withValue(projects, open('projects-btn', 'Manage'))),
    settingRow('Main projects folder', 'New projects are created under it, sorted by category.', root),
    settingRow('Accounts', 'Claude, Codex and Antigravity logins, one folder each. Type the name in a pane to start it.', withValue(accounts, open('accounts-btn', 'Manage'))),
    settingRow('Token usage', 'Tokens per Claude account, today and the last 7 days.', open('usage-btn', 'Open'))
  )
  return box
}

function aboutSection(close: () => void): HTMLElement {
  const box = el('div', 'set-section')
  const ver = el('span', 'set-value', '…')
  void window.lightclaude.appVersion().then((v) => (ver.textContent = `v${v}`))
  const notes = el('button', 'btn btn-sm', "What's new")
  notes.addEventListener('click', () => {
    close()
    document.getElementById('version-btn')?.click()
  })
  const verRow = el('div', 'set-stepper')
  verRow.append(ver, notes)

  const status = el('div', 'set-detail set-update-status')
  const check = el('button', 'btn btn-sm', 'Check for updates')
  check.addEventListener('click', () => {
    status.textContent = 'Checking…'
    void window.lightclaude.updates.check().then((r) => {
      status.textContent =
        r.status === 'dev'
          ? 'Update checks are off in dev mode.'
          : r.status === 'none'
            ? "You're on the latest version."
            : r.status === 'available'
              ? `v${r.version} is available, see the notification at the bottom right.`
              : `Check failed: ${r.message}`
    })
  })
  box.append(
    settingRow('Version', 'Light Code. Free for the community under MIT with the Commons Clause: not for sale.', verRow),
    settingRow('Updates', 'Light Code checks on launch and tells you when a new version is ready.', check),
    status
  )
  return box
}

let open = false

export function openSettings(initial: SectionId = 'general'): void {
  if (open) return
  open = true
  const m = openModal({
    title: 'Settings',
    subtitle: 'Everything Light Code lets you change, and what is installed.',
    icon: 'settings',
    className: 'settings-modal',
    onDismiss: () => (open = false)
  })
  const close = (): void => {
    open = false
    m.close()
  }
  m.footer.remove()

  const layout = el('div', 'set-layout')
  const nav = el('nav', 'set-nav')
  const pane = el('div', 'set-pane')
  layout.append(nav, pane)
  m.body.classList.add('set-body')
  m.body.appendChild(layout)

  let dispose: (() => void) | null = null
  const show = (id: SectionId): void => {
    dispose?.()
    dispose = null
    for (const b of nav.children) b.classList.toggle('on', (b as HTMLElement).dataset['id'] === id)
    pane.replaceChildren()
    pane.appendChild(el('h2', 'set-heading', SECTIONS.find((s) => s.id === id)!.label))
    if (id === 'general') pane.appendChild(generalSection())
    else if (id === 'install') {
      const s = installSection()
      dispose = s.dispose
      pane.appendChild(s.el)
    } else if (id === 'shortcuts') pane.appendChild(shortcutsSection(close))
    else pane.appendChild(aboutSection(close))
    pane.scrollTop = 0
  }
  for (const s of SECTIONS) {
    const b = el('button', 'set-nav-item')
    b.dataset['id'] = s.id
    const ic = el('span', 'set-nav-icon')
    ic.innerHTML = icon(s.icon, 16) // constant SVG only
    b.append(ic, el('span', undefined, s.label))
    b.addEventListener('click', () => show(s.id))
    nav.appendChild(b)
  }
  show(initial)
  disposeWhenGone(m.overlay, () => {
    open = false
    dispose?.()
  })
}

export function initSettingsUi(): void {
  document.getElementById('settings-btn')?.addEventListener('click', () => openSettings())
}
