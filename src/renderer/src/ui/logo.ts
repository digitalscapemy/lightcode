/**
 * The Light Code mark as inline SVG — the same shapes as build/icon.png (a
 * circle holding two interlocking rounded "L" brackets), so it stays crisp at
 * any size and can be animated with CSS alone.
 *
 * Animated (the welcome page): on arrival the circle settles in, the two
 * brackets draw themselves from their rounded ends and lock into place, the
 * stroke cooling from the accent to grey. Afterwards they breathe very slowly.
 * Flat colours only, no gradient or glow; prefers-reduced-motion shows the
 * finished mark, still. All CSS — no animation loop in JS, nothing running
 * while the page is hidden.
 *
 * Static (About dialog): just the mark.
 */
export function logoSvg(opts: { size?: number; animated?: boolean } = {}): string {
  const size = opts.size ?? 96
  const cls = 'lc-logo' + (opts.animated ? ' lc-logo-animated' : '')
  // Geometry traced from the 2134px icon, scaled to a 100-unit box.
  return (
    `<svg class="${cls}" width="${size}" height="${size}" viewBox="0 0 100 100" ` +
    `role="img" aria-label="Light Code">` +
    `<circle class="lc-logo-disc" cx="50" cy="50" r="48"/>` +
    `<g class="lc-logo-a"><path class="lc-logo-stroke" pathLength="100" d="M49.5 26.5 H73.5 V50.5"/></g>` +
    `<g class="lc-logo-b"><path class="lc-logo-stroke" pathLength="100" d="M26.5 49.5 V73.5 H50.5"/></g>` +
    `</svg>`
  )
}
