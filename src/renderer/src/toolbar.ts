import { allCommands } from './commands'
import { shortcutLabel, type ShortcutAction } from './keys'
import { openPalette } from './palette'
import { icon, type IconName } from './ui/icons'

/**
 * Dresses the toolbar in index.html: icons from the one icon set, labels on the
 * buttons that carry them, and tooltips built from the command registry — the
 * name, a line of what it does, and its shortcut written for this platform.
 * Reading the shortcut from the registry is what keeps a tooltip from promising
 * a key that does nothing.
 *
 * Also keeps a panel's button pressed while that panel is open.
 */
export function initToolbar(): void {
  const byId = new Map(allCommands().map((c) => [c.id, c]))

  for (const el of document.querySelectorAll<HTMLElement>('#tabbar [data-icon]')) {
    const name = el.dataset['icon'] as IconName
    if (el.classList.contains('tabbar-btn')) {
      el.innerHTML = icon(name, 16) // constant SVG only
      const label = el.dataset['label']
      if (label) {
        const span = document.createElement('span')
        span.className = 'tb-label'
        span.textContent = label
        el.appendChild(span)
      }
    } else {
      el.innerHTML = icon(name, 14) // constant SVG only
    }
  }

  for (const el of document.querySelectorAll<HTMLElement>('#tabbar [data-shortcut]')) {
    el.textContent = shortcutLabel(el.dataset['shortcut'] as ShortcutAction)
  }

  for (const el of document.querySelectorAll<HTMLElement>('#tabbar [data-command]')) {
    const cmd = byId.get(el.dataset['command']!)
    if (!cmd) continue
    el.dataset['tip'] = el.dataset['label'] ?? shortTitle(cmd.title)
    if (el.dataset['desc']) el.dataset['tipDesc'] = el.dataset['desc']
    if (cmd.shortcut) el.dataset['tipKey'] = shortcutLabel(cmd.shortcut)
    el.setAttribute('aria-label', cmd.title)
    el.removeAttribute('title') // the rich tooltip replaces the native one
  }

  document.getElementById('search-btn')?.addEventListener('click', () => void openPalette())
  document.getElementById('usage-btn')?.addEventListener('click', () => byId.get('usage')?.run())
  const search = document.getElementById('search-btn')
  if (search) {
    const key = shortcutLabel('command-palette')
    search.dataset['tipKey'] = key
  }

  // Pressed while its panel is open. Watching the panel's own `hidden` means
  // every way of opening it — button, shortcut, palette — is reflected.
  for (const btn of document.querySelectorAll<HTMLElement>('#tabbar [data-panel]')) {
    const panel = document.getElementById(btn.dataset['panel']!)
    if (!panel) continue
    const sync = (): void => {
      btn.classList.toggle('on', !panel.hidden)
      btn.setAttribute('aria-pressed', String(!panel.hidden))
    }
    new MutationObserver(sync).observe(panel, { attributes: true, attributeFilter: ['hidden'] })
    sync()
  }

  // Mission Control is a dialog rather than a docked panel: pressed while open.
  const mission = document.getElementById('mission-btn')
  if (mission) {
    const sync = (): void => {
      mission.classList.toggle('on', !!document.getElementById('mission-overlay'))
    }
    new MutationObserver(sync).observe(document.body, { childList: true })
  }
}

/** "Worktrees panel" → "Worktrees"; tooltips name the thing, not the widget. */
function shortTitle(title: string): string {
  return title.replace(/ panel$/, '').replace(/:.*$/, '')
}
