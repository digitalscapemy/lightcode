import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { isBabysitterOn, toggleBabysitter } from './babysitter'
import { MOD_LABEL, isAppShortcut } from './keys'
import { shellArgs } from './paths'
import { state } from './store'
import { xtermTheme } from './theme'

import type { PaneStatus } from '../../shared/ipc'
import type { Orientation } from '../../shared/types'

const STATUS_LABEL: Record<PaneStatus, string> = {
  working: 'Claude working',
  'waiting-input': 'Waiting for you',
  'waiting-approval': 'Needs approval',
  idle: 'Idle'
}

interface MenuItem {
  label: string
  action: () => void
  disabled?: boolean
}

// Monochrome glyphs (fill: currentColor) so the header can tint them one gray.
const KEY_ICON =
  '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M9.5 1a4.5 4.5 0 0 0-4.28 5.9L1.22 10.9a.75.75 0 0 0-.22.53v2.82c0 .41.34.75.75.75h2.5a.75.75 0 0 0 .75-.75V13h1.25a.75.75 0 0 0 .75-.75V11h1.13l.4-.4A4.5 4.5 0 1 0 9.5 1Zm2 3.25a1.25 1.25 0 1 1-2.5 0 1.25 1.25 0 0 1 2.5 0Z"/></svg>'
const FOLDER_ICON =
  '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M1.75 2.5A1.25 1.25 0 0 0 .5 3.75v8.5A1.25 1.25 0 0 0 1.75 13.5h12.5a1.25 1.25 0 0 0 1.25-1.25v-6.5A1.25 1.25 0 0 0 14.25 4.5H8.2L6.9 3.02a1.25 1.25 0 0 0-.93-.42H1.75Z"/></svg>'

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

/**
 * The one pane currently outlined as a file-drop target, app-wide. Kept as a
 * single module-level element rather than read back out of the DOM because
 * `dragover` fires continuously while the pointer moves — this is the hot path
 * for both the outline and main.ts's cursor, and it has to stay O(1) with zero
 * DOM work on the (overwhelmingly common) unchanged frame.
 */
let dropTargetEl: HTMLElement | null = null

function markDropTarget(el: HTMLElement | null): void {
  if (dropTargetEl === el) return
  dropTargetEl?.classList.remove('drag-over')
  el?.classList.add('drag-over')
  dropTargetEl = el
}

/** True while some pane is ready to take the drag (see main.ts's cursor). */
export function hasDropTarget(): boolean {
  return dropTargetEl !== null
}

/** Drop the outline wherever it is — for drags that end outside any pane. */
export function clearDropTarget(): void {
  markDropTarget(null)
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
  private acctBtn!: HTMLElement
  private projBtn!: HTMLElement
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
    const acctBtn = document.createElement('button')
    acctBtn.className = 'pane-acct-btn'
    acctBtn.innerHTML = KEY_ICON
    acctBtn.title = 'Switch Claude account'
    acctBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      void this.toggleQuickMenu('accounts', acctBtn)
    })
    this.acctBtn = acctBtn
    const projBtn = document.createElement('button')
    projBtn.className = 'pane-proj-btn'
    projBtn.innerHTML = FOLDER_ICON
    projBtn.title = 'Go to project'
    projBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      void this.toggleQuickMenu('projects', projBtn)
    })
    this.projBtn = projBtn
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
    killBtn.title = `Close pane (${MOD_LABEL}+Shift+W)`
    killBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      this.callbacks.onCloseRequest(this.id)
    })
    header.append(this.titleEl, this.statusEl, this.usageEl, acctBtn, projBtn, menuBtn, killBtn)

    this.body = document.createElement('div')
    this.body.className = 'pane-body'
    this.el.append(header, this.body)

    this.term = new Terminal({
      allowProposedApi: true,
      cursorBlink: true,
      cursorStyle: 'bar',
      cursorInactiveStyle: 'none',
      cursorWidth: 2,
      // Panes created after a zoom must open at the current size, not the
      // default — otherwise a new split in a zoomed-out grid comes back large.
      fontSize: state.fontSize,
      fontFamily: '"Cascadia Mono", Consolas, monospace',
      scrollback: 5000,
      theme: xtermTheme
    })
    this.term.loadAddon(this.fitAddon)
    // Let Ctrl+Shift+S/E/T/W bubble past xterm to the app dispatcher.
    this.term.attachCustomKeyEventHandler((e) => {
      if (isAppShortcut(e)) return false
      // Cmd on macOS, Ctrl elsewhere — the modifier for both clipboard keys.
      const clipMod =
        window.lightclaude.platform === 'darwin'
          ? e.metaKey && !e.ctrlKey
          : e.ctrlKey && !e.metaKey
      // Copy. Nothing else in the stack can do it: xterm's selection is drawn
      // into a canvas rather than the DOM, so the platform's own copy command
      // sees an empty hidden textarea and copies nothing — and on Windows
      // xterm preventDefaults Ctrl+C to send ^C, so no copy event even fires.
      // Only intercept when there IS a selection: with none, Ctrl+C has to
      // stay SIGINT, which on Windows is the only way to interrupt Claude.
      // Clearing the selection afterwards means the very next Ctrl+C
      // interrupts again, the same bargain Windows Terminal strikes.
      if (e.type === 'keydown' && clipMod && !e.altKey && e.key.toLowerCase() === 'c') {
        const selection = this.term.hasSelection() ? this.term.getSelection() : ''
        if (selection.trim()) {
          window.lightclaude.clipboard.copy(selection)
          this.term.clearSelection()
          e.preventDefault()
          return false
        }
      }
      // Paste (Ctrl+V / Cmd+V) goes through the main process so clipboard
      // IMAGES (Snipping Tool / screenshots) work: the image is saved to a
      // temp file and its quoted path is pasted — Claude Code attaches image
      // paths typed into the prompt. Plain text still pastes as text.
      if (e.type === 'keydown' && clipMod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'v') {
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

    // Drag a file or folder in from Finder/Explorer and its path is typed at
    // the prompt, exactly as a native terminal does it: type `cd `, drop the
    // folder, press Enter. Chromium's default for a dropped file is to NAVIGATE
    // the window to it — which here would replace the whole app and take every
    // pty with it — so both handlers must preventDefault. main.ts blocks the
    // same default window-wide for drops that miss a pane.
    this.el.addEventListener('dragenter', (e) => this.onDragOver(e))
    this.el.addEventListener('dragover', (e) => this.onDragOver(e))
    this.el.addEventListener('dragleave', (e) => {
      // Crossing between children fires dragleave on the one being left, so the
      // highlight may only clear once the pointer has left the pane itself
      // (relatedTarget is null when it leaves the window entirely).
      const to = e.relatedTarget as Node | null
      if (!to || !this.el.contains(to)) this.setDropTarget(false)
    })
    this.el.addEventListener('drop', (e) => this.onDrop(e))

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
  private menuAnchor: HTMLElement | null = null
  private outsideClose: ((e: PointerEvent) => void) | null = null

  private toggleMenu(): void {
    if (this.menuAnchor === this.menuBtn && this.menu) {
      this.closeMenu()
      return
    }
    this.openMenu(
      [
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
      ],
      this.menuBtn
    )
  }

  /** Account/project quick-picker, built from the saved shortcuts. */
  private async toggleQuickMenu(kind: 'accounts' | 'projects', anchor: HTMLElement): Promise<void> {
    if (this.menuAnchor === anchor && this.menu) {
      this.closeMenu()
      return
    }
    const cfg = await window.lightclaude.shortcuts.load()
    // The click that opened this may have raced a close — bail if disposed.
    if (this.exited) return
    let items: MenuItem[]
    if (kind === 'accounts') {
      // The default `claude` command uses ~/.claude; extra accounts follow.
      items = [
        { label: 'claude', action: () => void this.switchAccount('claude') },
        ...cfg.accounts.map((a) => ({
          label: a.name,
          action: () => void this.switchAccount(a.name)
        }))
      ]
    } else if (cfg.paths.length === 0) {
      items = [{ label: '— no projects saved —', disabled: true, action: () => {} }]
    } else {
      items = cfg.paths.map((p) => ({
        label: p.name,
        action: () => this.goToProject(p.path)
      }))
    }
    this.openMenu(items, anchor)
  }

  /** Build a floating `.pane-menu` from items and wire outside-close. */
  private openMenu(items: MenuItem[], anchor: HTMLElement): void {
    this.closeMenu()
    const menu = document.createElement('div')
    menu.className = 'pane-menu'
    for (const { label, action, disabled } of items) {
      const item = document.createElement('button')
      item.className = 'pane-menu-item'
      item.textContent = label
      if (disabled) {
        item.disabled = true
      } else {
        item.addEventListener('click', (e) => {
          e.stopPropagation()
          this.closeMenu()
          action()
        })
      }
      menu.appendChild(item)
    }
    this.el.appendChild(menu)
    this.menu = menu
    this.menuAnchor = anchor
    // Close on any press outside the menu. Presses on the anchor button are
    // left alone so its own click handler toggles the menu closed — closing
    // here would let the follow-up click reopen it.
    const onOutside = (e: PointerEvent): void => {
      const t = e.target as Node
      if (!this.menu?.contains(t) && !anchor.contains(t)) this.closeMenu()
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
    this.menuAnchor = null
  }

  /**
   * Launch the chosen account. If Claude is currently running in this pane,
   * `/exit` it first (then wait for the shell prompt before typing the
   * command); if the pane is already at the shell, run the command straight.
   */
  private async switchAccount(command: string): Promise<void> {
    if (this.exited) return
    const running = await window.lightclaude.pty.claudeActive(this.id)
    if (this.exited) return
    if (!running) {
      window.lightclaude.pty.write(this.id, command + '\r')
      return
    }
    window.lightclaude.pty.write(this.id, '/exit\r')
    // Give Claude a moment to tear down and return to the shell prompt before
    // the account command is typed; back-to-back risks it being swallowed.
    window.setTimeout(() => {
      if (!this.exited) window.lightclaude.pty.write(this.id, command + '\r')
    }, 700)
  }

  /** cd the pane into a saved project folder. */
  private goToProject(path: string): void {
    if (this.exited) return
    // `cd "..."` works in both PowerShell and POSIX shells; shell integration
    // (OSC cwd) then updates the pane's tracked cwd automatically.
    window.lightclaude.pty.write(this.id, `cd "${path}"\r`)
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
    if (item.type === 'file') {
      const args = shellArgs(item.paths)
      if (args) this.term.paste(args)
    } else if (item.type === 'image') this.term.paste(`"${item.path}"`)
    else if (item.type === 'text' && item.text) this.term.paste(item.text)
  }

  /**
   * Whether a drag carries something typeable. `types` is all that is readable
   * mid-drag — the files themselves stay sealed until the drop — so this is a
   * best guess by design, and dropText() decides what actually gets typed.
   */
  private static droppable(dt: DataTransfer | null): boolean {
    // dt.types is a live frozen array on both platforms — read it in place
    // rather than copying it, since this runs on every dragover frame.
    return !!dt && (dt.types.includes('Files') || dt.types.includes('text/plain'))
  }

  private onDragOver(e: DragEvent): void {
    if (this.exited || !TerminalPane.droppable(e.dataTransfer)) return
    e.preventDefault() // without this the drop event never fires at all
    // Windows shows "+ Copy" and macOS a green plus for this — both read as
    // "you'll get a copy of the path", which is exactly what happens.
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    this.setDropTarget(true)
  }

  /** Accent outline saying which pane the path will land in (see .drag-over). */
  private setDropTarget(on: boolean): void {
    if (on) markDropTarget(this.el)
    // Only ever clear our OWN outline: crossing straight from one pane into
    // another fires the new pane's dragenter BEFORE the old one's dragleave,
    // so an unguarded clear here would wipe the outline just set next door.
    else if (dropTargetEl === this.el) markDropTarget(null)
  }

  private onDrop(e: DragEvent): void {
    this.setDropTarget(false)
    if (this.exited || !TerminalPane.droppable(e.dataTransfer)) return
    e.preventDefault()
    const text = this.dropText(e.dataTransfer)
    if (!text) return
    // Focus follows the drop, so whatever is typed next continues here.
    this.term.focus()
    this.term.paste(text)
  }

  /**
   * What a drop should type. Reads the DataTransfer synchronously: it is
   * emptied the moment the drop handler returns, so nothing here may await.
   */
  private dropText(dt: DataTransfer | null): string {
    if (!dt) return ''
    // Files first: a Finder/Explorer drag also carries a text/plain of the bare
    // file NAME, which would otherwise win and type a name with no directory.
    // Electron 32 removed File.path, so the real path comes from the preload's
    // webUtils bridge; '' means the File has none (dragged out of a web page).
    const paths = Array.from(dt.files)
      .map((f) => window.lightclaude.filePath(f))
      .filter((p) => p !== '')
    if (paths.length > 0) {
      const args = shellArgs(paths)
      // Trailing space: the dropped path is a finished argument, so `cd ` +
      // drop + Enter works and a second drop lands as its own argument.
      return args ? args + ' ' : ''
    }
    // Not files — a URL or a text selection dragged in from another app. Typed
    // as-is, same as a clipboard paste of the same text would be.
    return dt.getData('text/plain')
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

  /**
   * Resize this terminal's text. Refitting is required, not cosmetic: the pane
   * keeps its pixel size, so a new font size means a different cols/rows count,
   * and the PTY has to be told or the shell keeps wrapping to the old width.
   */
  setFontSize(px: number): void {
    if (this.term.options.fontSize === px) return
    this.term.options.fontSize = px
    this.scheduleFit()
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
    this.setDropTarget(false) // a pane closed mid-drag must not stay "the" target
    this.closeMenu()
    this.ro.disconnect()
    this.detachWebgl()
    this.term.dispose()
    window.lightclaude.pty.kill(this.id)
    this.el.remove()
  }
}
