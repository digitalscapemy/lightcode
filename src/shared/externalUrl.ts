/**
 * Which links from a terminal may be handed to the operating system.
 *
 * Terminal output is untrusted — an agent prints whatever it reads, and an OSC 8
 * hyperlink can carry any URI at all. Opening `file:` would launch local files,
 * custom protocols launch arbitrary registered apps, and `javascript:` has no
 * business anywhere. So only the web and mail are allowed out.
 */
const ALLOWED = new Set(['http:', 'https:', 'mailto:'])

export function isSafeExternalUrl(url: unknown): url is string {
  if (typeof url !== 'string' || url.length > 8192) return false
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (!ALLOWED.has(parsed.protocol)) return false
  // A web link must name a host; `https:foo` parses but goes nowhere useful.
  return parsed.protocol === 'mailto:' || parsed.hostname.length > 0
}

/**
 * Plain-text URLs in a line of terminal output, for making them clickable.
 * Trailing punctuation that usually ends a sentence rather than a URL is left
 * off, and an unbalanced closing bracket too ("(see https://x.y/z)").
 */
export function findUrls(line: string): { url: string; start: number }[] {
  const out: { url: string; start: number }[] = []
  const re = /\bhttps?:\/\/[^\s"'<>`]+/g
  for (let m = re.exec(line); m; m = re.exec(line)) {
    let url = m[0]
    url = url.replace(/[.,;:!?]+$/, '')
    for (const [open, close] of [
      ['(', ')'],
      ['[', ']'],
      ['{', '}']
    ] as const) {
      while (url.endsWith(close) && count(url, open) < count(url, close)) url = url.slice(0, -1)
    }
    if (isSafeExternalUrl(url)) out.push({ url, start: m.index })
  }
  return out
}

function count(s: string, ch: string): number {
  return s.split(ch).length - 1
}
