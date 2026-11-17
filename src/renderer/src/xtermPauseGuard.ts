/**
 * Stops hidden terminals from repainting themselves on every line of output.
 *
 * xterm 6.0.0 refreshes the selection on every scroll — selection or not — and
 * that refresh reaches the renderer through RenderService.handleSelectionChanged,
 * which repaints every row without checking `_isPaused`, the flag xterm sets
 * for a terminal that is off screen. A background tab is `display: none`, so
 * its DOM renderer also measures every glyph as 0px wide, never caches the
 * result, and forces a layout per glyph. Measured: twelve background panes
 * printing a log stalled the UI by 60–150ms at a time, and 63% of all renderer
 * time went to that measuring — for rows nobody could see.
 *
 * While paused, the selection update is kept instead of drawn, and replayed
 * the moment xterm un-pauses the terminal (it is shown again). Nothing is lost:
 * xterm already queues a full repaint for that moment.
 *
 * This reaches into xterm internals, so every piece is checked first; if any
 * is missing (a different xterm version), the terminal is left untouched and
 * behaves exactly as stock xterm does.
 */

type SelectionArgs = [start: unknown, end: unknown, columnSelectMode: unknown]

interface RenderServiceLike {
  _isPaused: boolean
  handleSelectionChanged: (...args: SelectionArgs) => void
  _handleIntersectionChange: (entry: unknown) => void
}

function renderServiceOf(term: unknown): RenderServiceLike | null {
  const rs = (term as { _core?: { _renderService?: Partial<RenderServiceLike> } })?._core
    ?._renderService
  if (
    !rs ||
    typeof rs._isPaused !== 'boolean' ||
    typeof rs.handleSelectionChanged !== 'function' ||
    typeof rs._handleIntersectionChange !== 'function'
  ) {
    return null
  }
  return rs as RenderServiceLike
}

/** Returns true when the guard was installed, false when xterm did not match. */
export function guardPausedSelectionRedraw(term: unknown): boolean {
  const rs = renderServiceOf(term)
  if (!rs) return false

  const handleSelection = rs.handleSelectionChanged.bind(rs)
  const handleIntersection = rs._handleIntersectionChange.bind(rs)
  let pending: SelectionArgs | null = null

  rs.handleSelectionChanged = (...args: SelectionArgs): void => {
    if (rs._isPaused) {
      pending = args // newest wins: only the current selection matters
      return
    }
    pending = null
    handleSelection(...args)
  }

  rs._handleIntersectionChange = (entry: unknown): void => {
    handleIntersection(entry)
    if (!rs._isPaused && pending) {
      const args = pending
      pending = null
      handleSelection(...args)
    }
  }
  return true
}
