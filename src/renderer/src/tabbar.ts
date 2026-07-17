import type { TabState } from '../../shared/types'
import { state, tabStatus } from './store'

export interface TabBarCallbacks {
  onActivate(tabId: string): void
  onClose(tabId: string): void
  onRename(tabId: string, name: string): void
  onReorderCommit(): void
  onAdd(): void
}

let cb: TabBarCallbacks

export function initTabBar(callbacks: TabBarCallbacks): void {
  cb = callbacks
  document.getElementById('add-tab')!.addEventListener('click', () => cb.onAdd())
}

const tabEls = new Map<string, HTMLElement>()

/** The drag in flight, if any. Module-level so renderTabs can see and end it. */
interface DragSession {
  el: HTMLElement
  end: () => void
}
let session: DragSession | null = null

/** Strip every trace of a drag from a tab. Safe to call on a tab never dragged. */
function clearDragVisuals(el: HTMLElement): void {
  el.classList.remove('dragging')
  el.style.transition = ''
  el.style.transform = ''
}

/**
 * Updates tab elements in place instead of rebuilding them — replacing the
 * nodes between two clicks would reset the browser's double-click counter
 * and break dblclick-to-rename.
 */
export function renderTabs(): void {
  const box = document.getElementById('tabs')!
  for (const [id, el] of tabEls) {
    if (!state.tabs.some((t) => t.id === id)) {
      // A tab can be closed mid-drag (pty exit, Ctrl+Shift+W). Ending the drag
      // before the node dies is the only chance to run its cleanup.
      if (session?.el === el) session.end()
      el.remove()
      tabEls.delete(id)
    }
  }
  let prev: HTMLElement | null = null
  for (const tab of state.tabs) {
    let el = tabEls.get(tab.id)
    if (!el) {
      el = makeTabEl(tab)
      tabEls.set(tab.id, el)
    }
    el.classList.toggle('active', tab.id === state.activeTabId)
    // Belt and braces: a drag that somehow ended without its own cleanup must
    // never strand a tab under a stale translateX. Keyed on .dragging rather
    // than on the transform, which would also wipe siblings' in-flight FLIP.
    if (el.classList.contains('dragging') && session?.el !== el) clearDragVisuals(el)
    if (el.title !== tab.projectPath) el.title = tab.projectPath
    applyTabStatus(el, tab)
    const label = el.querySelector('.tab-label')
    // Only touch the text node when it actually changed — replacing it between
    // two clicks resets the browser's double-click counter.
    if (label && label.textContent !== tab.name) label.textContent = tab.name
    if (prev) {
      if (prev.nextSibling !== el) prev.after(el)
    } else if (box.firstChild !== el) {
      box.prepend(el)
    }
    prev = el
  }
  if (!session) document.body.classList.remove('tab-dragging')
}

function makeTabEl(tab: TabState): HTMLElement {
  const el = document.createElement('div')
  el.className = 'tab' + (tab.id === state.activeTabId ? ' active' : '')
  el.dataset['tabId'] = tab.id
  el.title = tab.projectPath

  const dot = document.createElement('span')
  dot.className = 'tab-status'
  el.appendChild(dot)

  const label = document.createElement('span')
  label.className = 'tab-label'
  label.textContent = tab.name
  el.appendChild(label)

  const closeBtn = document.createElement('button')
  closeBtn.className = 'tab-close'
  closeBtn.textContent = '×'
  closeBtn.title = 'Close tab'
  closeBtn.addEventListener('click', (e) => {
    e.stopPropagation()
    cb.onClose(tab.id)
  })
  el.appendChild(closeBtn)

  let dragged = false
  el.addEventListener('click', () => {
    if (!dragged) cb.onActivate(tab.id)
  })
  el.addEventListener('dblclick', (e) => {
    if ((e.target as HTMLElement).closest('.tab-close')) return
    beginRename(el, label, tab.id)
  })
  el.addEventListener('pointerdown', (e) =>
    startDrag(e, el, () => (dragged = true), () => {
      // let the trailing click event see dragged=true, then reset
      setTimeout(() => (dragged = false))
    })
  )

  return el
}

/** Colour a tab's status dot by the most attention-worthy pane inside it. */
function applyTabStatus(el: HTMLElement, tab: TabState): void {
  const dot = el.querySelector<HTMLElement>('.tab-status')
  if (!dot) return
  const status = tabStatus(tab)
  if (status === 'idle') dot.removeAttribute('data-status')
  else dot.dataset['status'] = status
}

/** Re-colour every tab's status dot in place (called on status ticks). */
export function refreshTabStatuses(): void {
  for (const [id, el] of tabEls) {
    const tab = state.tabs.find((t) => t.id === id)
    if (tab) applyTabStatus(el, tab)
  }
}

/** Untransformed slot geometry, measured once per drag. */
interface Slots {
  /** Mirrors the DOM order of box.children. */
  order: HTMLElement[]
  width: Map<HTMLElement, number>
}

/**
 * offsetWidth, not getBoundingClientRect().width: the dragged tab is scaled and
 * displaced siblings are mid-FLIP, so live rects lie. Layout widths don't.
 */
function measureSlots(box: HTMLElement): Slots {
  const order = Array.from(box.children) as HTMLElement[]
  const width = new Map(order.map((o) => [o, o.offsetWidth]))
  return { order, width }
}

/**
 * Drag-to-reorder with a visible drag effect: the tab follows the pointer
 * (lifted, with shadow), and displaced siblings slide into place (FLIP).
 *
 * Everything hangs off `window` and funnels through one idempotent `end()`.
 * Listening on the tab itself used to strand drags: a mouse gets no implicit
 * pointer capture, so a coalesced flick (pointerdown at x=800, next delivered
 * move already at x=500) never reaches the tab, pointerup lands elsewhere, and
 * the cleanup never runs — leaving the tab stuck under a stale transform with
 * a leaked listener set that the next drag then fights over.
 */
function startDrag(
  e: PointerEvent,
  el: HTMLElement,
  markDragged: () => void,
  onDone: () => void
): void {
  if (e.button !== 0) return
  if ((e.target as HTMLElement).closest('.tab-close') || el.querySelector('input')) return
  session?.end() // a fresh press is the last-resort reaper for an orphaned drag

  const box = el.parentElement!
  const pid = e.pointerId
  const startX = e.clientX
  const grabOffset = startX - el.getBoundingClientRect().left
  let active = false // past the 6px threshold
  let ended = false
  let tx = 0 // current translateX of the dragged tab
  let raf = 0
  let latest: PointerEvent | null = null
  let slots: Slots | null = null

  // Capture here rather than at the threshold, and treat it as a nicety: the
  // window listeners are the authority. Chromium drops capture whenever the
  // element leaves the document, which every reorder below does.
  try {
    el.setPointerCapture(pid)
  } catch {
    // pointer already gone — window listeners still carry the drag
  }

  const end = (): void => {
    if (ended) return
    ended = true
    if (raf) cancelAnimationFrame(raf)
    raf = 0
    latest = null
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    window.removeEventListener('pointercancel', onUp)
    window.removeEventListener('blur', onUp)
    document.removeEventListener('visibilitychange', onHide)
    try {
      if (el.hasPointerCapture(pid)) el.releasePointerCapture(pid)
    } catch {
      // capture already released
    }
    if (session?.el === el) session = null

    if (active) {
      el.classList.remove('dragging')
      document.body.classList.remove('tab-dragging')
      if (el.isConnected) {
        // Snap into the final slot. transform always changes here (scale 1.04
        // → none), so transitionend is guaranteed and the listener is collected.
        el.style.transition = 'transform 0.12s ease'
        el.style.transform = ''
        el.addEventListener(
          'transitionend',
          () => {
            el.style.transition = ''
          },
          { once: true }
        )
      } else {
        clearDragVisuals(el) // detached: no transition will ever fire
      }
      cb.onReorderCommit()
    }
    onDone()
  }

  const frame = (): void => {
    raf = 0
    const ev = latest
    latest = null
    if (ended || !ev) return

    if (!active) {
      if (Math.abs(ev.clientX - startX) < 6) return
      active = true
      markDragged()
      slots = measureSlots(box)
      el.style.transition = '' // a previous drag's snap must not lag this one
      el.classList.add('dragging')
      document.body.classList.add('tab-dragging')
    }
    const s = slots!

    // Read everything up front; every write happens below.
    const boxRect = box.getBoundingClientRect()
    const originX = boxRect.left - box.scrollLeft // client x of slot 0
    const leftOf = (idx: number): number => {
      let x = originX
      for (let k = 0; k < idx; k++) x += s.width.get(s.order[k]!)!
      return x
    }

    // Cross as many midpoints as this (possibly coalesced) move warrants,
    // resolving on the model so one flick costs one DOM mutation, not five.
    let moved = false
    for (let guard = s.order.length; guard-- > 0; ) {
      const my = s.order.indexOf(el)
      let target = -1
      for (let i = 0; i < s.order.length; i++) {
        if (i === my) continue
        const mid = leftOf(i) + s.width.get(s.order[i]!)! / 2
        if ((i < my && ev.clientX < mid) || (i > my && ev.clientX > mid)) {
          target = i
          break
        }
      }
      if (target < 0) break
      s.order.splice(my, 1)
      s.order.splice(target, 0, el)
      moved = true
    }

    if (moved) {
      moveWithFlip(box, el, () => {
        box.insertBefore(el, s.order[s.order.indexOf(el) + 1] ?? null)
        // The insert detached el, which dropped the capture. Retake it.
        if (!el.hasPointerCapture(pid)) {
          try {
            el.setPointerCapture(pid)
          } catch {
            // pointer gone — window listeners still carry the drag
          }
        }
      })
      syncOrderFromDom(box)
    }

    // The tab itself sticks to the pointer, clamped inside the tab strip so
    // it never floats over the "+" button or past the first tab. tx is derived
    // from the model, never from a live rect — reading back a transform we
    // wrote is how a stale value compounds into a tab flying off-screen.
    const w = s.width.get(el)!
    const maxLeft = Math.max(boxRect.left, boxRect.right - w)
    const desired = Math.min(Math.max(ev.clientX - grabOffset, boxRect.left), maxLeft)
    tx = desired - leftOf(s.order.indexOf(el))
    el.style.transform = `translateX(${tx}px) scale(1.04)`
  }

  const onMove = (ev: PointerEvent): void => {
    if (ended || ev.pointerId !== pid) return
    if (active && ev.buttons === 0) {
      end() // a release we never saw
      return
    }
    latest = ev
    if (!raf) raf = requestAnimationFrame(frame)
  }
  const onUp = (ev: Event): void => {
    if (ev instanceof PointerEvent && ev.pointerId !== pid) return
    end()
  }
  const onHide = (): void => {
    if (document.hidden) end()
  }

  session = { el, end }
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
  window.addEventListener('pointercancel', onUp)
  window.addEventListener('blur', onUp)
  document.addEventListener('visibilitychange', onHide)
}

/** FLIP: siblings displaced by the reorder slide smoothly into their new spot. */
function moveWithFlip(box: HTMLElement, dragEl: HTMLElement, mutate: () => void): void {
  const others = (Array.from(box.children) as HTMLElement[]).filter((c) => c !== dragEl)
  const before = new Map(others.map((o) => [o, o.getBoundingClientRect().left]))
  mutate()
  for (const o of others) {
    const delta = (before.get(o) ?? 0) - o.getBoundingClientRect().left
    if (!delta) continue
    o.style.transition = 'none'
    o.style.transform = `translateX(${delta}px)`
    o.getBoundingClientRect() // force reflow so the transition below animates
    o.style.transition = 'transform 0.15s ease'
    o.style.transform = ''
    o.addEventListener(
      'transitionend',
      () => {
        o.style.transition = ''
      },
      { once: true }
    )
  }
}

function syncOrderFromDom(box: HTMLElement): void {
  const order = Array.from(box.children).map((c) => (c as HTMLElement).dataset['tabId'])
  state.tabs.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id))
}

function beginRename(el: HTMLElement, label: HTMLElement, tabId: string): void {
  if (el.querySelector('input')) return
  const input = document.createElement('input')
  input.className = 'tab-rename'
  input.value = label.textContent ?? ''
  label.replaceWith(input)
  input.focus()
  input.select()

  let done = false
  const commit = (): void => {
    if (done) return
    done = true
    const name = input.value.trim()
    input.replaceWith(label)
    if (name) cb.onRename(tabId, name)
  }
  const cancel = (): void => {
    if (done) return
    done = true
    input.replaceWith(label)
  }
  input.addEventListener('keydown', (e) => {
    e.stopPropagation()
    if (e.key === 'Enter') commit()
    else if (e.key === 'Escape') cancel()
  })
  input.addEventListener('blur', commit)
}
