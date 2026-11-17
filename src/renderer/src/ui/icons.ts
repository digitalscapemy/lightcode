/**
 * The app's one icon set.
 *
 * Inline SVG on a 16px grid, 1.5px strokes, round caps, `currentColor` — so an
 * icon takes the colour of the text around it and needs no CSS of its own.
 * Drawn here rather than loaded: the page's CSP only allows its own origin, and
 * a handful of paths is smaller than any icon library.
 *
 * Use `icon('name')` for markup, or `iconEl('name')` for a node.
 */

const P = {
  close: '<path d="M4 4l8 8M12 4l-8 8"/>',
  more: '<circle cx="8" cy="3.5" r=".9" fill="currentColor" stroke="none"/><circle cx="8" cy="8" r=".9" fill="currentColor" stroke="none"/><circle cx="8" cy="12.5" r=".9" fill="currentColor" stroke="none"/>',
  plus: '<path d="M8 3v10M3 8h10"/>',
  chevronDown: '<path d="M4 6l4 4 4-4"/>',
  chevronRight: '<path d="M6 4l4 4-4 4"/>',
  search: '<circle cx="7" cy="7" r="4.25"/><path d="M10.25 10.25L13.5 13.5"/>',
  command:
    '<path d="M6 6V4.5A1.5 1.5 0 1 0 4.5 6H6zm0 0h4M6 6v4m4-4V4.5A1.5 1.5 0 1 1 11.5 6H10zm0 0v4m0 0h1.5a1.5 1.5 0 1 1-1.5 1.5V10zm0 0H6m0 0v1.5A1.5 1.5 0 1 1 4.5 10H6z"/>',
  keyboard:
    '<rect x="1.75" y="4" width="12.5" height="8" rx="1.5"/><path d="M4.5 6.75h.01M7 6.75h.01M9.5 6.75h.01M12 6.75h.01M5 9.5h6"/>',
  layout: '<rect x="2.25" y="2.25" width="11.5" height="11.5" rx="1.5"/><path d="M8 2.25v11.5M2.25 8h11.5"/>',
  /** One task, several agents: a line that splits into three. */
  fanOut: '<circle cx="3" cy="8" r="1.25"/><path d="M4.25 8H7m0 0c2 0 2-4.5 4.5-4.5M7 8h4.5M7 8c2 0 2 4.5 4.5 4.5"/><circle cx="12.75" cy="3.5" r="1.25"/><circle cx="12.75" cy="8" r="1.25"/><circle cx="12.75" cy="12.5" r="1.25"/>',
  /** A team of roles: people. */
  squad:
    '<circle cx="6" cy="5.5" r="2.25"/><path d="M1.75 13c.4-2.3 2.1-3.75 4.25-3.75S9.85 10.7 10.25 13"/><circle cx="11.5" cy="6.25" r="1.75"/><path d="M11.75 9.4c1.6.2 2.6 1.4 2.75 3.1"/>',
  /** A lead directing others: one node with lines out to several. */
  orchestra:
    '<circle cx="8" cy="3.5" r="1.75"/><circle cx="3.25" cy="12.25" r="1.5"/><circle cx="8" cy="12.25" r="1.5"/><circle cx="12.75" cy="12.25" r="1.5"/><path d="M8 5.25v5.5M7 4.9L3.9 10.8M9 4.9l3.1 5.9"/>',
  worktrees:
    '<circle cx="4.5" cy="3.5" r="1.5"/><circle cx="4.5" cy="12.5" r="1.5"/><circle cx="11.5" cy="5.5" r="1.5"/><path d="M4.5 5v6M11.5 7c0 2.5-2 3-5.5 4.25"/>',
  /** Everything at once: a dashboard of gauges. */
  mission: '<rect x="2" y="2" width="5" height="5" rx="1"/><rect x="9" y="2" width="5" height="5" rx="1"/><rect x="2" y="9" width="5" height="5" rx="1"/><rect x="9" y="9" width="5" height="5" rx="1"/>',
  projects: '<path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.6l1.4 1.5h5A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z"/>',
  folder: '<path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.6l1.4 1.5h5A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z"/>',
  accounts: '<circle cx="8" cy="5.5" r="2.75"/><path d="M2.75 13.5c.5-2.6 2.6-4.25 5.25-4.25s4.75 1.65 5.25 4.25"/>',
  key: '<circle cx="5.25" cy="10.75" r="2.75"/><path d="M7.2 8.8L13 3m-2 2l1.75 1.75M9.5 6.5l1.25 1.25"/>',
  terminal: '<rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.5"/><path d="M4.5 6.25L6.75 8 4.5 9.75M8.5 10h3"/>',
  check: '<path d="M3.5 8.5l3 3 6-7"/>',
  info: '<circle cx="8" cy="8" r="6"/><path d="M8 7.25V11M8 5h.01"/>',
  warning: '<path d="M7.13 2.5a1 1 0 0 1 1.74 0l5.5 9.75a1 1 0 0 1-.87 1.5H2.5a1 1 0 0 1-.87-1.5z"/><path d="M8 6.5v3M8 11.5h.01"/>',
  error: '<circle cx="8" cy="8" r="6"/><path d="M6 6l4 4M10 6l-4 4"/>',
  /** Auto-continue: a loop that keeps going. */
  repeat: '<path d="M3 7V6a2 2 0 0 1 2-2h7.5m-2-2l2 2-2 2M13 9v1a2 2 0 0 1-2 2H3.5m2 2l-2-2 2-2"/>',
  splitRight: '<rect x="2.25" y="2.25" width="11.5" height="11.5" rx="1.5"/><path d="M8 2.25v11.5"/>',
  splitDown: '<rect x="2.25" y="2.25" width="11.5" height="11.5" rx="1.5"/><path d="M2.25 8h11.5"/>',
  maximize: '<path d="M9.5 2.5h4v4M6.5 13.5h-4v-4M13.5 2.5L9 7M2.5 13.5L7 9"/>',
  rename: '<path d="M10.5 2.75l2.75 2.75L6 12.75 2.75 13.25 3.25 10z"/>',
  external: '<path d="M9 2.5h4.5V7M13.5 2.5L7.5 8.5M11.5 9.5v3a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3"/>',
  sparkle: '<path d="M8 2v3M8 11v3M2 8h3M11 8h3M4 4l2 2M10 10l2 2M12 4l-2 2M6 10l-2 2"/>'
} as const

export type IconName = keyof typeof P

/** SVG markup for an icon, sized in px (16 by default). */
export function icon(name: IconName, size = 16): string {
  return (
    `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" ` +
    `stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" ` +
    `aria-hidden="true" focusable="false">${P[name]}</svg>`
  )
}

/**
 * The same icon as a DOM node, for code that builds elements.
 * Parsing is safe here: the markup is only ever the constant paths above,
 * picked by a typed key, and `size` is a number — no outside text gets in.
 */
export function iconEl(name: IconName, size = 16): SVGSVGElement {
  const t = document.createElement('template')
  t.innerHTML = icon(name, size)
  return t.content.firstElementChild as SVGSVGElement
}

export const ICON_NAMES = Object.keys(P) as IconName[]
