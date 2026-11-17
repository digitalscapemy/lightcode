import type { ILink, ILinkProvider, Terminal } from '@xterm/xterm'
import { findUrls, isSafeExternalUrl } from '../../shared/externalUrl'

const isMac = window.lightclaude.platform === 'darwin'

/** Ctrl+click elsewhere, ⌘+click on macOS — what every terminal does. */
function hasLinkModifier(e: MouseEvent): boolean {
  return isMac ? e.metaKey : e.ctrlKey
}

/**
 * Open a link from terminal output in the default browser. Main checks the
 * scheme again; this check just avoids a pointless round trip.
 */
export function openTerminalLink(e: MouseEvent, uri: string): void {
  if (!hasLinkModifier(e)) return
  if (!isSafeExternalUrl(uri)) return
  e.preventDefault()
  window.lightclaude.openExternal(uri)
}

/**
 * Makes plain-text http(s) URLs clickable (Ctrl/⌘+click). Built on xterm's own
 * link-provider API rather than the web-links addon: it is a few lines, and it
 * shares one scheme allow-list with OSC 8 links.
 *
 * Works one buffer row at a time, so a URL that wraps onto a second row is only
 * clickable on its first part — the same limit most terminals have.
 */
export function webLinkProvider(term: Terminal): ILinkProvider {
  return {
    provideLinks(y, callback) {
      const line = term.buffer.active.getLine(y - 1)
      if (!line) return callback(undefined)
      const text = line.translateToString(true)
      const found = findUrls(text)
      if (found.length === 0) return callback(undefined)
      const links: ILink[] = found.map(({ url, start }) => ({
        text: url,
        // xterm ranges are 1-based and inclusive.
        range: { start: { x: start + 1, y }, end: { x: start + url.length, y } },
        decorations: { underline: true, pointerCursor: true },
        activate: (e) => openTerminalLink(e, url)
      }))
      callback(links)
    }
  }
}
