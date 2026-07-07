import type { TabState } from '../../shared/types'
import { state } from './store'

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

/**
 * Updates tab elements in place instead of rebuilding them — replacing the
 * nodes between two clicks would reset the browser's double-click counter
 * and break dblclick-to-rename.
 */
export function renderTabs(): void {
  const box = document.getElementById('tabs')!
  for (const [id, el] of tabEls) {
    if (!state.tabs.some((t) => t.id === id)) {
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
    if (el.title !== tab.projectPath) el.title = tab.projectPath
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
}

function makeTabEl(tab: TabState): HTMLElement {
  const el = document.createElement('div')
  el.className = 'tab' + (tab.id === state.activeTabId ? ' active' : '')
  el.dataset['tabId'] = tab.id
  el.title = tab.projectPath

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

/**
 * Drag-to-reorder with a visible drag effect: the tab follows the pointer
 * (lifted, with shadow), and displaced siblings slide into place (FLIP).
 */
function startDrag(
  e: PointerEvent,
  el: HTMLElement,
  markDragged: () => void,
  onDone: () => void
): void {
  if (e.button !== 0) return
  if ((e.target as HTMLElement).closest('.tab-close') || el.querySelector('input')) return

  const box = el.parentElement!
  const startX = e.clientX
  const grabOffset = startX - el.getBoundingClientRect().left
  let dragging = false
  let tx = 0 // current translateX of the dragged tab

  const applyDragTransform = (): void => {
    el.style.transform = `translateX(${tx}px) scale(1.04)`
  }

  const onMove = (ev: PointerEvent): void => {
    if (!dragging) {
      if (Math.abs(ev.clientX - startX) < 6) return
      dragging = true
      markDragged()
      el.setPointerCapture(e.pointerId)
      el.classList.add('dragging')
      document.body.classList.add('tab-dragging')
    }

    // Swap slots when the pointer crosses a sibling's midpoint.
    const siblings = Array.from(box.children) as HTMLElement[]
    const myIndex = siblings.indexOf(el)
    for (let i = 0; i < siblings.length; i++) {
      if (siblings[i] === el) continue
      const rect = siblings[i].getBoundingClientRect()
      const mid = rect.left + rect.width / 2
      if (i < myIndex && ev.clientX < mid) {
        moveWithFlip(box, el, () => box.insertBefore(el, siblings[i]))
        syncOrderFromDom(box)
        break
      }
      if (i > myIndex && ev.clientX > mid) {
        moveWithFlip(box, el, () => box.insertBefore(el, siblings[i].nextSibling))
        syncOrderFromDom(box)
        break
      }
    }

    // The tab itself sticks to the pointer, clamped inside the tab strip so
    // it never floats over the "+" button or past the first tab.
    const slotLeft = el.getBoundingClientRect().left - tx
    const boxRect = box.getBoundingClientRect()
    const maxLeft = Math.max(boxRect.left, boxRect.right - el.offsetWidth)
    const desired = Math.min(Math.max(ev.clientX - grabOffset, boxRect.left), maxLeft)
    tx = desired - slotLeft
    applyDragTransform()
  }

  const onUp = (): void => {
    el.removeEventListener('pointermove', onMove)
    el.removeEventListener('pointerup', onUp)
    el.removeEventListener('pointercancel', onUp)
    if (dragging) {
      el.classList.remove('dragging')
      document.body.classList.remove('tab-dragging')
      // Snap into the final slot.
      el.style.transition = 'transform 0.12s ease'
      el.style.transform = ''
      el.addEventListener(
        'transitionend',
        () => {
          el.style.transition = ''
        },
        { once: true }
      )
      cb.onReorderCommit()
    }
    onDone()
  }
  el.addEventListener('pointermove', onMove)
  el.addEventListener('pointerup', onUp)
  el.addEventListener('pointercancel', onUp)
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
