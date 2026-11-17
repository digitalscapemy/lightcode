/**
 * Fuzzy matching for the command palette.
 *
 * Every character of the query must appear in the text, in order. Matches
 * score higher when they start a word ("sr" → "Split Right"), run together,
 * or sit near the start — so the obvious command comes first without the user
 * typing it out. Returns null when the text does not match at all.
 */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.trim().toLowerCase()
  if (q === '') return 0
  const t = text.toLowerCase()

  // A plain substring is the strongest signal there is.
  const sub = t.indexOf(q)
  if (sub !== -1) {
    const atWord = sub === 0 || /[\s\-_/:.]/.test(t[sub - 1]!)
    return 1000 - sub + (atWord ? 200 : 0) + (q.length === t.length ? 300 : 0)
  }

  let score = 0
  let ti = 0
  let prev = -2
  for (const ch of q) {
    if (ch === ' ') continue
    const found = t.indexOf(ch, ti)
    if (found === -1) return null
    const atWord = found === 0 || /[\s\-_/:.]/.test(t[found - 1]!)
    score += atWord ? 30 : 1
    if (found === prev + 1) score += 15 // consecutive
    score -= Math.min(found - ti, 10) // gap
    prev = found
    ti = found + 1
  }
  return score
}

/** Rank items by their best-matching field; non-matches are dropped. */
export function fuzzyRank<T>(query: string, items: T[], fields: (item: T) => string[]): T[] {
  if (query.trim() === '') return items
  const scored: { item: T; score: number; i: number }[] = []
  items.forEach((item, i) => {
    let best: number | null = null
    fields(item).forEach((f, fi) => {
      const s = fuzzyScore(query, f)
      // The first field (the title) counts more than keywords.
      const weighted = s === null ? null : fi === 0 ? s + 50 : s
      if (weighted !== null && (best === null || weighted > best)) best = weighted
    })
    if (best !== null) scored.push({ item, score: best, i })
  })
  scored.sort((a, b) => b.score - a.score || a.i - b.i)
  return scored.map((s) => s.item)
}
