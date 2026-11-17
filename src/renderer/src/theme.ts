import type { ITheme } from '@xterm/xterm'

/**
 * The terminal's background and text follow the design tokens in styles.css
 * (--term-bg, --fg), so a pane and the chrome around it are the same colour.
 * Read once, when the first terminal is built; the fallbacks are the token
 * values in case the stylesheet has not applied yet.
 */
function token(name: string, fallback: string): string {
  try {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback
  } catch {
    return fallback
  }
}

const TERM_BG = token('--term-bg', '#0b0b0d')
const TERM_FG = token('--fg', '#e4e4e7')

/** Dark-only. Near-black background per user preference. */
export const xtermTheme: ITheme = {
  background: TERM_BG,
  foreground: TERM_FG,
  cursor: TERM_FG,
  cursorAccent: TERM_BG,
  selectionBackground: '#264f78',
  black: '#000000',
  red: '#cd3131',
  green: '#0dbc79',
  yellow: '#e5e510',
  blue: '#2472c8',
  magenta: '#bc3fbc',
  cyan: '#11a8cd',
  white: '#e5e5e5',
  brightBlack: '#666666',
  brightRed: '#f14c4c',
  brightGreen: '#23d18b',
  brightYellow: '#f5f543',
  brightBlue: '#3b8eea',
  brightMagenta: '#d670d6',
  brightCyan: '#29b8db',
  brightWhite: '#ffffff'
}
