import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { isBabysitterOn, toggleBabysitter } from './babysitter'
import { isAppShortcut } from './keys'
import { xtermTheme } from './theme'

import type { PaneStatus } from '../../shared/ipc'
import type { Orientation } from '../../shared/types'

const STATUS_LABEL: Record<PaneStatus, string> = {
  working: 'Claude working',
  'waiting-input': 'Waiting for you',
  'waiting-approval': 'Needs approval',
  idle: 'Idle'
}

export interface PaneCallbacks {
  onCloseRequest(paneId: string): void
  onFocus(paneId: string): void
  onSplit(paneId: string, orientation: Orientation, before: boolean): void
  onToggleMaximize(paneId: string): void
  isMaximized(paneId: string): boolean
  /** Null clears the custom name and resumes shell titles. */
  onRename(paneId: string, name: string | null): void
  /** A human keystroke reached the terminal (resets the babysitter counter). */
  onManualInput?(paneId: string): void
}

/** PowerShell's default window titles are long paths — shorten the noise. */
function tidyTitle(raw: string): string {
  const t = raw.trim().replace(/^Administrator:\s*/i, '')
  if (/(powershell|pwsh)(\.exe)?$/i.test(t)) return 'PowerShell'
  return t
}

export class TerminalPane {
  readonly el: HTMLElement
  readonly term: Terminal
  exited = false

  private fitAddon = new FitAddon()
  private webgl: WebglAddon | null = null
  private ro: ResizeObserver
  private rafPending = false
  private loading: HTMLElement | null = null
  private body: HTMLElement
  private titleEl: HTMLElement
  private statusEl: HTMLElement
  private usageEl: HTMLElement
  private menuBtn: HTMLElement
  private customName: string | null = null
  private autoTitle = window.lightclaude.platform === 'win32' ? 'PowerShell' : 'Terminal'

  constructor(
    readonly id: string,
    readonly cwd: string,
    private callbacks: PaneCallbacks
  ) {
    this.el = document.createElement('div')
    this.el.className = 'pane'
    this.el.dataset['paneId'] = id

    const header = document.createElement('div')
    header.className = 'pane-header'
    this.titleEl = document.createElement('span')
    this.titleEl.className = 'pane-title'
    this.titleEl.textContent = window.lightclaude.platform === 'win32' ? 'PowerShell' : 'Terminal'
    this.statusEl = document.createElement('span')
    this.statusEl.className = 'pane-status'
    this.statusEl.hidden = true
    this.usageEl = document.createElement('span')
    this.usageEl.className = 'pane-usage'
    this.usageEl.hidden = true
    const menuBtn = document.createElement('button')
    menuBtn.className = 'pane-menu-btn'
    menuBtn.textContent = '⋮'
    menuBtn.title = 'Pane menu'
    menuBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      this.toggleMenu()
    })
    this.menuBtn = menuBtn
    const killBtn = document.createElement('button')
    killBtn.className = 'pane-kill'
    killBtn.textContent = '×'
    killBtn.title = 'Close pane (Ctrl+Shift+W)'
    killBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      this.callbacks.onCloseRequest(this.id)
    })
    header.append(this.titleEl, this.statusEl, this.usageEl, menuBtn, killBtn)

    this.body = document.createElement('div')
    this.body.className = 'pane-body'
    this.el.append(header, this.body)

    this.term = new Terminal({
      allowProposedApi: true,
      cursorBlink: true,
      cursorStyle: 'bar',
      cursorInactiveStyle: 'none',
      cursorWidth: 2,
      fontSize: 14,
      fontFamily: '"Cascadia Mono", Consolas, monospace',
      scrollback: 5000,
      theme: xtermTheme
    })
    this.term.loadAddon(this.fitAddon)
    // Let Ctrl+Shift+S/E/T/W bubble past xterm to the app dispatcher.
    this.term.attachCustomKeyEventHandler((e) => {
      if (isAppShortcut(e)) return false
      // Paste (Ctrl+V / Cmd+V) goes through the main process so clipboard
      // IMAGES (Snipping Tool / screenshots) work: the image is saved to a
      // temp file and its quoted path is pasted — Claude Code attaches image
      // paths typed into the prompt. Plain text still pastes as text.
      const pasteMod =
        window.lightclaude.platform === 'darwin'
          ? e.metaKey && !e.ctrlKey
          : e.ctrlKey && !e.metaKey
      if (e.type === 'keydown' && pasteMod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'v') {
        e.preventDefault()
        void this.pasteClipboard()
        return false
      }
      return true
    })
    this.term.open(this.body)
    this.term.onData((data) => {
      window.lightclaude.pty.write(this.id, data)
      this.callbacks.onManualInput?.(this.id)
    })
    this.term.onResize(({ cols, rows }) => window.lightclaude.pty.resize(this.id, cols, rows))
    this.term.onTitleChange((title) => {
      const tidy = tidyTitle(title)
      if (tidy) {
        this.autoTitle = tidy
        if (!this.customName) this.titleEl.textContent = tidy
      }
    })
    // Drag-selecting blank rows paints a big empty highlight — drop
    // selections that contain no visible text.
    this.term.onSelectionChange(() => {
      if (this.term.hasSelection() && this.term.getSelection().trim() === '') {
        this.term.clearSelection()
      }
    })
    // ...and stop selections from starting on empty rows at all, so the blue
    // highlight never appears while dragging over the blank area.
    this.body.addEventListener(
      'mousedown',
      (e) => {
        if (e.button !== 0 || this.exited) return
        const screen = this.body.querySelector<HTMLElement>('.xterm-screen')
        if (!screen || !screen.contains(e.target as Node)) return
        const rect = screen.getBoundingClientRect()
        const cellH = rect.height / this.term.rows
        if (cellH <= 0) return
        const absRow = this.term.buffer.active.viewportY + Math.floor((e.clientY - rect.top) / cellH)
        if (absRow > this.lastContentRow()) {
          e.preventDefault()
          e.stopPropagation()
          this.term.focus()
        }
      },
      { capture: true }
    )

    this.el.addEventListener('focusin', () => this.callbacks.onFocus(this.id))
    this.el.addEventListener('mousedown', (e) => {
      // Don't steal focus from the inline rename input or the pane menu.
      if ((e.target as HTMLElement).closest('input, .pane-menu')) return
      if (!this.exited) this.term.focus()
    })

    // "Starting up" indicator, cleared by the first byte of pty output.
    const loading = document.createElement('div')
    loading.className = 'loading-overlay'
    const spinner = document.createElement('div')
    spinner.className = 'spinner'
    const text = document.createElement('span')
    text.textContent = 'Starting terminal…'
    loading.append(spinner, text)
    this.body.appendChild(loading)
    this.loading = loading

    this.ro = new ResizeObserver(() => this.scheduleFit())
    this.ro.observe(this.body)
  }

  private clearLoading(): void {
    this.loading?.remove()
    this.loading = null
  }

  /** Absolute buffer index of the last row containing visible text. */
  private lastContentRow(): number {
    const buf = this.term.buffer.active
    for (let i = buf.length - 1; i >= 0; i--) {
      const line = buf.getLine(i)
      if (line && line.translateToString(true).trim() !== '') return i
    }
    return -1
  }

  private menu: HTMLElement | null = null
  private outsideClose: ((e: PointerEvent) => void) | null = null

  private toggleMenu(): void {
    if (this.menu) {
      this.closeMenu()
      return
    }
    const menu = document.createElement('div')
    menu.className = 'pane-menu'
    const items: { label: string; action: () => void }[] = [
      { label: 'Rename', action: () => this.beginRename() },
      { label: 'Add Right', action: () => this.callbacks.onSplit(this.id, 'row', false) },
      { label: 'Add Left', action: () => this.callbacks.onSplit(this.id, 'row', true) },
      { label: 'Add Above', action: () => this.callbacks.onSplit(this.id, 'column', true) },
      { label: 'Add Below', action: () => this.callbacks.onSplit(this.id, 'column', false) },
      {
        label: this.callbacks.isMaximized(this.id) ? 'Restore Pane' : 'Maximize Pane',
        action: () => this.callbacks.onToggleMaximize(this.id)
      },
      {
        label: isBabysitterOn(this.id) ? 'Auto-continue: On' : 'Auto-continue: Off',
        action: () => void toggleBabysitter(this.id)
      }
    ]
    for (const { label, action } of items) {
      const item = document.createElement('button')
      item.className = 'pane-menu-item'
      item.textContent = label
      item.addEventListener('click', (e) => {
        e.stopPropagation()
        this.closeMenu()
        action()
      })
      menu.appendChild(item)
    }
    this.el.appendChild(menu)
    this.menu = menu
    // Close on any press outside the menu. Presses on the ⋮ button are left
    // alone so its own click handler toggles the menu closed — closing here
    // would let the follow-up click reopen it.
    const onOutside = (e: PointerEvent): void => {
      const t = e.target as Node
      if (!this.menu?.contains(t) && !this.menuBtn.contains(t)) this.closeMenu()
    }
    document.addEventListener('pointerdown', onOutside, { capture: true })
    this.outsideClose = onOutside
  }

  private closeMenu(): void {
    if (this.outsideClose) {
      document.removeEventListener('pointerdown', this.outsideClose, { capture: true })
      this.outsideClose = null
    }
    this.menu?.remove()
    this.menu = null
  }

  /** Apply a persisted/user-set title; null resumes shell titles. */
  setCustomName(name: string | null): void {
    this.customName = name
    this.titleEl.textContent = name ?? this.autoTitle
  }

  /** Current display title (custom name or the live shell title). */
  label(): string {
    return this.customName ?? this.autoTitle
  }

  /** Inline title edit, mirroring the tab-rename flow. */
  private beginRename(): void {
    if (this.el.querySelector('.pane-rename')) return
    const input = document.createElement('input')
    input.className = 'pane-rename'
    input.value = this.customName ?? ''
    input.placeholder = this.autoTitle
    this.titleEl.replaceWith(input)
    input.focus()
    input.select()

    let done = false
    const commit = (): void => {
      if (done) return
      done = true
      const name = input.value.trim()
      input.replaceWith(this.titleEl)
      this.callbacks.onRename(this.id, name || null)
    }
    const cancel = (): void => {
      if (done) return
      done = true
      input.replaceWith(this.titleEl)
    }
    input.addEventListener('keydown', (e) => {
      e.stopPropagation()
      if (e.key === 'Enter') commit()
      else if (e.key === 'Escape') cancel()
    })
    input.addEventListener('blur', commit)
  }

  /** Token usage badge; null hides it. */
  setUsage(text: string | null, tooltip = ''): void {
    this.usageEl.hidden = text === null
    this.usageEl.textContent = text ?? ''
    this.usageEl.title = tooltip
  }

  /** Claude activity pill; the dot colour carries the state, text stays terse. */
  setStatus(status: PaneStatus | null, lastTool: string | null = null): void {
    if (!status || status === 'idle') {
      this.statusEl.hidden = true
      this.statusEl.textContent = ''
      delete this.statusEl.dataset['status']
      return
    }
    this.statusEl.hidden = false
    this.statusEl.dataset['status'] = status
    this.statusEl.textContent =
      status === 'waiting-approval'
        ? 'needs approval'
        : status === 'waiting-input'
          ? 'waiting'
          : (lastTool?.toLowerCase() ?? '')
    this.statusEl.title = STATUS_LABEL[status] + (lastTool ? ` · ${lastTool}` : '')
  }

  private async pasteClipboard(): Promise<void> {
    const item = await window.lightclaude.clipboard.paste()
    if (!item || this.exited) return
    if (item.type === 'image') this.term.paste(`"${item.path}"`)
    else if (item.text) this.term.paste(item.text)
  }

  async spawn(): Promise<void> {
    this.fit()
    try {
      const result = await window.lightclaude.pty.spawn({
        paneId: this.id,
        cwd: this.cwd,
        cols: this.term.cols,
        rows: this.term.rows
      })
      if (result.cwdFallback) {
        this.write(`\x1b[33mProject folder not found — opened in ${result.cwd}\x1b[0m\r\n`)
      }
    } catch {
      const text = this.loading?.querySelector('span')
      if (text) text.textContent = 'Failed to start terminal'
      this.loading?.querySelector('.spinner')?.remove()
    }
  }

  write(data: string): void {
    if (this.loading) this.clearLoading()
    this.term.write(data)
  }

  scheduleFit(): void {
    if (this.rafPending) return
    this.rafPending = true
    requestAnimationFrame(() => {
      this.rafPending = false
      this.fit()
    })
  }

  fit(): void {
    // Skip hidden/zero-size containers (e.g. background tabs).
    if (!this.el.isConnected || this.el.clientWidth < 20 || this.el.clientHeight < 20) return
    this.fitAddon.fit()
  }

  attachWebgl(): void {
    if (this.webgl || this.exited) return
    try {
      const addon = new WebglAddon()
      addon.onContextLoss(() => {
        addon.dispose()
        this.webgl = null
      })
      this.term.loadAddon(addon)
      this.webgl = addon
    } catch {
      this.webgl = null // no GPU — xterm stays on the DOM renderer
    }
  }

  detachWebgl(): void {
    this.webgl?.dispose()
    this.webgl = null
  }

  showExitOverlay(exitCode: number): void {
    if (this.exited) return
    this.exited = true
    this.clearLoading()
    this.detachWebgl()
    const overlay = document.createElement('div')
    overlay.className = 'exit-overlay'
    overlay.tabIndex = 0
    const msg = document.createElement('div')
    msg.textContent = `Process exited (code ${exitCode})`
    const hint = document.createElement('div')
    hint.className = 'hint'
    hint.textContent = 'Press any key or click to close this pane'
    overlay.append(msg, hint)
    const close = (): void => this.callbacks.onCloseRequest(this.id)
    overlay.addEventListener('keydown', (e) => {
      if (!isAppShortcut(e)) close()
    })
    overlay.addEventListener('click', close)
    this.body.appendChild(overlay)
    overlay.focus()
  }

  focus(): void {
    if (this.exited) {
      this.el.querySelector<HTMLElement>('.exit-overlay')?.focus()
    } else {
      this.term.focus()
    }
  }

  dispose(): void {
    this.closeMenu()
    this.ro.disconnect()
    this.detachWebgl()
    this.term.dispose()
    window.lightclaude.pty.kill(this.id)
    this.el.remove()
  }
}
