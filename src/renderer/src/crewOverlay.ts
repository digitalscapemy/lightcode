import type { LinkSegment } from '../../shared/crew'

/**
 * The dashed lines from an orchestra's lead to its workers, drawn over a tab.
 *
 * One SVG per tab view, laid over the whole of it with a 0 0 1 1 viewBox, so
 * the segments crew.linkSegments computes in fractions of the tab go straight
 * in as coordinates and the browser does the scaling — a window resize needs no
 * redraw at all. The stroke stays a pixel wide however the box is stretched
 * (non-scaling-stroke), and the SVG takes no pointer events, so nothing under
 * it is ever harder to click.
 *
 * Drawn only for the crew of the pane that has the focus (app.refreshCrewLinks
 * decides which), and taken away entirely when there is nothing to draw — a tab
 * without an orchestra in it never has an SVG in it.
 */

const SVG_NS = 'http://www.w3.org/2000/svg'
const overlays = new WeakMap<HTMLElement, SVGSVGElement>()

/**
 * Draw `segments` over `view`, or clear it when there are none. `working` names
 * the workers mid-turn, whose lines animate; `hue` is the crew's colour.
 *
 * Safe to call after renderLayout has emptied the view: the SVG is put back.
 */
export function drawCrewOverlay(
  view: HTMLElement,
  segments: LinkSegment[],
  hue: number,
  working: ReadonlySet<string>
): void {
  let svg = overlays.get(view)
  if (segments.length === 0) {
    svg?.remove()
    return
  }
  if (!svg) {
    svg = document.createElementNS(SVG_NS, 'svg')
    svg.classList.add('crew-overlay')
    svg.setAttribute('viewBox', '0 0 1 1')
    svg.setAttribute('preserveAspectRatio', 'none')
    svg.setAttribute('aria-hidden', 'true')
    overlays.set(view, svg)
  }
  if (svg.parentElement !== view) view.appendChild(svg)
  svg.style.setProperty('--crew-hue', String(hue))
  svg.textContent = ''
  for (const s of segments) {
    const line = document.createElementNS(SVG_NS, 'line')
    line.setAttribute('x1', String(s.x1))
    line.setAttribute('y1', String(s.y1))
    line.setAttribute('x2', String(s.x2))
    line.setAttribute('y2', String(s.y2))
    line.setAttribute('vector-effect', 'non-scaling-stroke')
    if (working.has(s.pane)) line.classList.add('working')
    svg.appendChild(line)
  }
}
