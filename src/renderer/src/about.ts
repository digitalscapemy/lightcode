import { CHANGELOG, DEVELOPER } from '../../shared/changelog'
import { panes } from './app'
import { state } from './store'

let overlay: HTMLElement | null = null
let version = ''

export function initAboutUi(): void {
  const btn = document.getElementById('version-btn')!
  void window.lightclaude.appVersion().then((v) => {
    version = v
    btn.textContent = `v${v}`
  })
  btn.addEventListener('click', openModal)
}

function openModal(): void {
  if (overlay) return

  overlay = document.createElement('div')
  overlay.id = 'shortcuts-overlay'
  overlay.addEventListener('pointerdown', (e) => {
    if (e.target === overlay) closeModal()
  })

  const modal = document.createElement('div')
  modal.className = 'shortcuts-modal about-modal'
  overlay.appendChild(modal)

  const header = document.createElement('div')
  header.className = 'shortcuts-header'
  const title = document.createElement('span')
  title.textContent = 'About'
  const closeBtn = document.createElement('button')
  closeBtn.className = 'shortcuts-close'
  closeBtn.textContent = '×'
  closeBtn.addEventListener('click', closeModal)
  header.append(title, closeBtn)
  modal.appendChild(header)

  const body = document.createElement('div')
  body.className = 'shortcuts-body'
  modal.appendChild(body)

  const hero = document.createElement('div')
  hero.className = 'about-hero'
  const logo = document.createElement('img')
  logo.className = 'about-logo'
  logo.src = './logo.png'
  logo.alt = 'LightClaude'
  const name = document.createElement('div')
  name.className = 'about-name'
  name.textContent = 'LightClaude'
  const ver = document.createElement('div')
  ver.className = 'about-version'
  ver.textContent = `v${version}`
  const dev = document.createElement('div')
  dev.className = 'about-developer'
  dev.textContent = `Developed by ${DEVELOPER}`
  hero.append(logo, name, ver, dev)
  body.appendChild(hero)

  const logTitle = document.createElement('div')
  logTitle.className = 'about-changelog-title'
  logTitle.textContent = 'Changelog'
  body.appendChild(logTitle)

  const log = document.createElement('div')
  log.className = 'about-changelog'
  for (const entry of CHANGELOG) {
    const head = document.createElement('div')
    head.className = 'about-entry-head'
    head.textContent = `v${entry.version} — ${entry.date}`
    const list = document.createElement('ul')
    list.className = 'about-entry-notes'
    for (const note of entry.notes) {
      const li = document.createElement('li')
      li.textContent = note
      list.appendChild(li)
    }
    log.append(head, list)
  }
  body.appendChild(log)

  const footer = document.createElement('div')
  footer.className = 'shortcuts-footer'
  const status = document.createElement('div')
  status.className = 'shortcuts-status'
  const updateBtn = document.createElement('button')
  updateBtn.className = 'shortcuts-primary'
  updateBtn.textContent = 'Check for updates'
  updateBtn.addEventListener('click', () => {
    status.textContent = 'Checking…'
    void window.lightclaude.updates.check().then((r) => {
      switch (r.status) {
        case 'dev':
          status.textContent = 'Update checks are disabled in dev mode.'
          break
        case 'none':
          status.textContent = "You're on the latest version."
          break
        case 'available':
          status.textContent = `Update v${r.version} available — see the notification.`
          break
        case 'error':
          status.textContent = `Check failed: ${r.message}`
          break
      }
    })
  })
  footer.append(status, updateBtn)
  modal.appendChild(footer)

  document.addEventListener('keydown', onKeydown, { capture: true })
  document.body.appendChild(overlay)
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
