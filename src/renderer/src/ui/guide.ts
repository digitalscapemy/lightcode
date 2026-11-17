import { GUIDES, type GuideId } from '../../../shared/guides'
import { openModal } from './modal'
import { toast } from './toast'

/**
 * Shows a guide from shared/guides.ts: what happened, why, and numbered steps
 * with the command to copy or the settings page to open. For the fixes that
 * are the user's to make, so they are never left holding only an error.
 */
export function openGuide(id: GuideId): void {
  const g = GUIDES[id]
  const m = openModal({ title: g.title, icon: 'info', className: 'guide-modal' })
  m.body.classList.add('guide')

  const why = document.createElement('p')
  why.className = 'guide-why'
  why.textContent = g.why
  m.body.appendChild(why)
  if (g.noAdmin) {
    const chip = document.createElement('span')
    chip.className = 'chip chip-accent'
    chip.textContent = 'No admin rights needed'
    m.body.appendChild(chip)
  }

  const list = document.createElement('ol')
  list.className = 'guide-steps'
  for (const step of g.steps) {
    const li = document.createElement('li')
    const text = document.createElement('div')
    text.textContent = step.text
    li.appendChild(text)
    if (step.command) {
      const cmdRow = document.createElement('div')
      cmdRow.className = 'guide-command'
      const code = document.createElement('code')
      code.textContent = step.command
      const copy = document.createElement('button')
      copy.className = 'btn btn-sm'
      copy.textContent = 'Copy'
      const command = step.command
      copy.addEventListener('click', () => {
        window.lightclaude.clipboard.copy(command)
        copy.textContent = 'Copied'
        toast({ tone: 'success', title: 'Command copied', detail: 'Paste it into PowerShell and press Enter.' })
      })
      cmdRow.append(code, copy)
      li.appendChild(cmdRow)
    }
    if (step.url) {
      const link = document.createElement('button')
      link.className = 'btn btn-sm'
      link.textContent = step.urlLabel ?? 'Open page'
      const url = step.url
      link.addEventListener('click', () => window.lightclaude.openExternal(url))
      li.appendChild(link)
    }
    if (step.page) {
      const btn = document.createElement('button')
      btn.className = 'btn btn-sm'
      btn.textContent = step.pageLabel ?? 'Open settings'
      const page = step.page
      btn.addEventListener('click', () => window.lightclaude.openSystemPage(page))
      li.appendChild(btn)
    }
    list.appendChild(li)
  }
  m.body.appendChild(list)

  const done = document.createElement('button')
  done.className = 'shortcuts-primary'
  done.textContent = 'Done'
  done.addEventListener('click', () => m.close())
  m.footer.appendChild(done)
  done.focus()
}
