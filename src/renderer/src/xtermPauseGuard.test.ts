import { describe, expect, it, vi } from 'vitest'
import { guardPausedSelectionRedraw } from './xtermPauseGuard'

function fakeTerm(paused: boolean) {
  const drawn: unknown[][] = []
  const rs = {
    _isPaused: paused,
    handleSelectionChanged(...args: unknown[]) {
      drawn.push(args)
    },
    _handleIntersectionChange(entry: { isIntersecting: boolean }) {
      this._isPaused = !entry.isIntersecting
    }
  }
  return { term: { _core: { _renderService: rs } }, rs, drawn }
}

describe('guardPausedSelectionRedraw', () => {
  it('draws selection changes straight away while visible', () => {
    const { term, rs, drawn } = fakeTerm(false)
    expect(guardPausedSelectionRedraw(term)).toBe(true)
    rs.handleSelectionChanged(1, 2, false)
    expect(drawn).toEqual([[1, 2, false]])
  })

  it('holds them while hidden and replays only the newest when shown', () => {
    const { term, rs, drawn } = fakeTerm(true)
    guardPausedSelectionRedraw(term)
    rs.handleSelectionChanged(1, 1, false)
    rs.handleSelectionChanged(3, 4, true)
    expect(drawn).toEqual([])
    rs._handleIntersectionChange({ isIntersecting: true })
    expect(drawn).toEqual([[3, 4, true]])
    // nothing pending any more: showing again draws nothing extra
    rs._handleIntersectionChange({ isIntersecting: true })
    expect(drawn).toHaveLength(1)
  })

  it('replays nothing when no selection change happened while hidden', () => {
    const { term, rs, drawn } = fakeTerm(true)
    guardPausedSelectionRedraw(term)
    rs._handleIntersectionChange({ isIntersecting: true })
    expect(drawn).toEqual([])
  })

  it('leaves an unrecognised xterm alone', () => {
    const handle = vi.fn()
    const term = { _core: { _renderService: { handleSelectionChanged: handle } } }
    expect(guardPausedSelectionRedraw(term)).toBe(false)
    expect(term._core._renderService.handleSelectionChanged).toBe(handle)
    expect(guardPausedSelectionRedraw({})).toBe(false)
    expect(guardPausedSelectionRedraw(null)).toBe(false)
  })
})
