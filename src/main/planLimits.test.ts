import { execFileSync } from 'child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { limitsKey, parseStatusLine } from '../shared/planLimits'

vi.mock('electron', () => ({ app: { getPath: () => '' } }))

const { windowsStatusLineScript, posixStatusLineScript, statusLineSetting } = await import('./planLimits')

const SAMPLE = {
  model: { display_name: 'Fable' },
  workspace: { current_dir: 'C:\\Projects\\Café' },
  rate_limits: {
    five_hour: { used_percentage: 34.5, resets_at: 1_900_000_000 },
    seven_day: { used_percentage: 66, resets_at: 1_900_300_000 }
  }
}

describe('parseStatusLine', () => {
  it('reads both windows, resets in ms', () => {
    const r = parseStatusLine(JSON.stringify(SAMPLE))
    expect(r.fiveHour).toEqual({ usedPercent: 34.5, resetsAt: 1_900_000_000_000 })
    expect(r.sevenDay).toEqual({ usedPercent: 66, resetsAt: 1_900_300_000_000 })
  })

  it('is empty, never throwing, without rate limits or on bad JSON', () => {
    expect(parseStatusLine('{"model":{}}')).toEqual({ fiveHour: null, sevenDay: null })
    expect(parseStatusLine('not json')).toEqual({ fiveHour: null, sevenDay: null })
    expect(parseStatusLine('{"rate_limits":{"five_hour":{"used_percentage":"x"}}}').fiveHour).toBeNull()
  })
})

describe('limitsKey', () => {
  it('ignores case, separators and a trailing slash', () => {
    expect(limitsKey('C:\\Users\\Me\\.claude-1\\')).toBe(limitsKey('c:/users/me/.claude-1'))
    expect(limitsKey('/Users/me/.claude')).toBe('_users_me__claude')
  })
})

describe('statusLineSetting', () => {
  it('is a command string a shell reads as one path', () => {
    const s = statusLineSetting(process.platform === 'win32' ? 'C:\\A B\\statusline.ps1' : '/A B/statusline.sh')
    expect(s.type).toBe('command')
    expect(s.command).toContain(process.platform === 'win32' ? '"C:/A B/statusline.ps1"' : "'/A B/statusline.sh'")
  })
})

describe('posixStatusLineScript', () => {
  it('quotes the limits folder and always exits 0', () => {
    const s = posixStatusLineScript("/x/it's here")
    expect(s).toContain("dir='/x/it'\\''s here'")
    expect(s.trimEnd().endsWith('exit 0')).toBe(true)
  })
})

// The real thing, on Windows: PowerShell runs the generated script.
const win = process.platform === 'win32'
describe.skipIf(!win)('the Windows status line script', () => {
  const root = mkdtempSync(join(tmpdir(), 'lc-sl-'))
  const limits = join(root, 'limits')
  const account = join(root, 'acc é')
  mkdirSync(limits)
  mkdirSync(account)
  const script = join(root, 'statusline.ps1')
  writeFileSync(script, '\ufeff' + windowsStatusLineScript(limits), 'utf8')
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  const run = (input: string): string =>
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], {
      input: Buffer.from(input, 'utf8'),
      cwd: root,
      env: { ...process.env, CLAUDE_CONFIG_DIR: account },
      timeout: 30_000
    }).toString('utf8')

  it('saves the rate limits under the account key and prints nothing without a status line', () => {
    const out = run(JSON.stringify(SAMPLE))
    expect(out).toBe('')
    const saved = join(limits, `${limitsKey(account)}.json`)
    expect(existsSync(saved)).toBe(true)
    expect(parseStatusLine(readFileSync(saved, 'utf8')).sevenDay?.usedPercent).toBe(66)
  })

  it("runs the account's own status line with the same input and passes its output through", () => {
    // A command that reads stdin, so the input really reaches it; output has non-ASCII.
    writeFileSync(
      join(account, 'settings.json'),
      JSON.stringify({ statusLine: { type: 'command', command: 'echo "mine ▸ $(cat | wc -c)"' } })
    )
    const input = JSON.stringify(SAMPLE)
    const out = run(input)
    expect(out.trim()).toBe(`mine ▸ ${Buffer.byteLength(input, 'utf8')}`)
  })

  it('does not save anything when there are no rate limits', () => {
    rmSync(join(limits, `${limitsKey(account)}.json`))
    run('{"model":{}}')
    expect(existsSync(join(limits, `${limitsKey(account)}.json`))).toBe(false)
  })
})
