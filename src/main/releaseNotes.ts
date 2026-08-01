/**
 * Reducing an update's release notes to plain lines the renderer can put
 * straight into textContent.
 *
 * Two shapes arrive, and they look nothing alike:
 *
 *  - the markdown bullets scripts/release-notes.cjs embeds in latest.yml at
 *    build time — the good path, already exactly what changelog.ts said;
 *  - HTML for the whole GitHub release body, which electron-updater's GitHub
 *    provider falls back to whenever the feed carries no notes of its own
 *    (a release whose version had no changelog entry, so nothing was embedded).
 *
 * Text only, never markup. This comes off the network, so the renderer must
 * never be handed something it could be tempted to innerHTML.
 */

/** Notes for one version as electron-updater hands them over. */
export type RawReleaseNotes = string | Array<{ note?: string | null }> | null | undefined

/** A toast is not a changelog viewer. */
const MAX_NOTES = 8

export function parseNotes(raw: RawReleaseNotes): string[] {
  if (!raw) return []
  const text = typeof raw === 'string' ? raw : raw.map((r) => r?.note ?? '').join('\n')
  return toLines(isHtml(text) ? newsFromHtml(text) : text)
}

function isHtml(s: string): boolean {
  return /<\/?[a-z][^>]*>/i.test(s)
}

/**
 * The news out of a rendered release body. A body is mostly furniture — a
 * download table, install instructions, a heading or two — and the part that
 * says what changed is the bullet list, so take that whenever there is one.
 *
 * Found by running a real update against the real GitHub release rather than a
 * fixture: flattening the whole body had the toast proudly listing "Your
 * machine", "File", "Windows 10/11" — the cells of the download table. Markdown
 * table rows start with a `|` and were already dropped; rendered ones are
 * `<td>`s and sailed straight through.
 */
function newsFromHtml(html: string): string {
  // Each <li> collapses to exactly one line, so a wrapped bullet cannot arrive
  // as several notes.
  const items = [...html.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)].map((m) =>
    (m[1] ?? '').replace(/\s+/g, ' ').trim()
  )
  if (items.length > 0) return items.join('\n')
  // No list at all — drop the furniture wholesale, contents included, and let
  // whatever prose remains stand in for it.
  return html
    .replace(/<table[\s\S]*?<\/table>/gi, '')
    .replace(/<h\d[\s\S]*?<\/h\d>/gi, '')
    .replace(/<pre[\s\S]*?<\/pre>/gi, '')
}

function toLines(text: string): string[] {
  return text
    .replace(/<\/(p|li|ul|ol|div|tr|h\d)>/gi, '\n') // block ends are line breaks
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&amp;/g, '&') // last, so the others can't be double-decoded
    .split('\n')
    .map((line) => line.trim().replace(/^[-*]\s+/, ''))
    // Raw markdown furniture, for the same reason the HTML kind is dropped.
    .filter((line) => line !== '' && !line.startsWith('|') && !line.startsWith('#'))
    .slice(0, MAX_NOTES)
}
