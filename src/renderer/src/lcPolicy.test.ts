import { describe, expect, it } from 'vitest'
import {
  MAX_CREW_WORKERS,
  PASTE_ENTER_DELAY_MS,
  SPAWN_BURST,
  SPAWN_WINDOW_MS,
  approvalKeystroke,
  approveGate,
  cleanLines,
  interruptKeystroke,
  lastMeaningfulLine,
  pauseGate,
  sendExpectsReply,
  sendGate,
  sendKeystrokes,
  spawnBranch,
  spawnGate,
  waitState
} from './lcPolicy'
import type { WaitView } from './lcPolicy'

describe('sendGate', () => {
  const gate = (o: Partial<Parameters<typeof sendGate>[0]>): ReturnType<typeof sendGate> =>
    sendGate({ target: 'p_b', from: 'p_a', status: undefined, force: false, ...o })

  it('lets an ordinary send through without a word', () => {
    expect(gate({ status: 'waiting-input' })).toEqual({ allow: true })
    expect(gate({ status: undefined })).toEqual({ allow: true })
  })

  // The text would land in the prompt of the agent that sent it, mid-turn.
  it('refuses a pane sending to itself, even with --force', () => {
    expect(gate({ from: 'p_b' }).allow).toBe(false)
    expect(gate({ from: 'p_b', force: true }).allow).toBe(false)
  })

  it('cannot call a send its own when it does not know who is asking', () => {
    expect(gate({ from: undefined }).allow).toBe(true)
  })

  // Keys typed at a permission menu answer it; that has to be a choice.
  it('refuses a pane showing a permission prompt unless forced', () => {
    const refused = gate({ status: 'waiting-approval' })
    expect(refused.allow).toBe(false)
    if (!refused.allow) expect(refused.error).toContain('--force')
    const forced = gate({ status: 'waiting-approval', force: true })
    expect(forced.allow).toBe(true)
    if (forced.allow) expect(forced.warning).toBeDefined()
  })

  // An estimated status cannot show a prompt, so the check above never fires
  // there; a reply-sized send from an agent is what would answer one unseen.
  describe('a pane whose status is only estimated', () => {
    const est = (text: string, o: Partial<Parameters<typeof sendGate>[0]> = {}) =>
      gate({ source: 'heuristic', status: 'idle', byAgent: true, text, ...o })

    it('refuses prompt-sized replies from an agent unless forced', () => {
      for (const t of ['y', 'n', '1', '2', 'yes', 'No', ' ok ', '', 'always']) {
        expect(est(t).allow).toBe(false)
      }
      expect(est('y', { force: true }).allow).toBe(true)
    })

    it('lets real instructions through', () => {
      expect(est('run the tests and report back').allow).toBe(true)
      expect(est('fix it').allow).toBe(true)
      expect(est('Please refactor the parser\nand add tests').allow).toBe(true)
    })

    // Codex answers its menu on the key itself: y / a / n.
    it('refuses a first keystroke that is a menu hotkey letter', () => {
      for (const t of ['yeah, go on', 'Now run the tests', 'add a test for it', '  y please']) {
        expect(est(t).allow).toBe(false)
      }
      const refused = est('now run the tests')
      if (!refused.allow) expect(refused.error).toMatch(/Please/)
    })

    // A menu reads keys as they arrive: the first line and first key decide.
    it('judges by what would be typed first, not the whole message', () => {
      expect(est('y\nplease carry on with the refactor').allow).toBe(false)
      expect(est('yes.\r\nthen run the suite').allow).toBe(false)
      expect(est('1. Run the tests\n2. Report back').allow).toBe(false)
      expect(est('   \nrun it').allow).toBe(false)
    })

    it('refuses control and escape characters (arrow keys, Esc)', () => {
      expect(est('\x1b[B then continue').allow).toBe(false)
      expect(est('carry on\x1b').allow).toBe(false)
      expect(est('tabs\tare fine').allow).toBe(true)
    })

    it('never stops the person at the keyboard', () => {
      expect(est('y', { byAgent: false }).allow).toBe(true)
    })

    it('leaves panes with a known status alone', () => {
      expect(est('y', { source: 'hook' }).allow).toBe(true)
      expect(est('y', { source: undefined }).allow).toBe(true)
    })
  })

  it('sends to a working pane, and says it was mid-turn', () => {
    const out = gate({ status: 'working' })
    expect(out.allow).toBe(true)
    if (out.allow) expect(out.warning).toContain('mid-turn')
  })
})

describe('sendKeystrokes', () => {
  // The plain path has to be byte-for-byte what it always was.
  it('sends one line and Enter as a single write, exactly as before', () => {
    expect(sendKeystrokes('hello', true, true)).toEqual([{ data: 'hello\r', delayMs: 0 }])
    expect(sendKeystrokes('hello', false, true)).toEqual([{ data: 'hello', delayMs: 0 }])
  })

  it('pastes several lines as one block, then presses Enter after a pause', () => {
    expect(sendKeystrokes('one\ntwo\r\nthree', true, true)).toEqual([
      { data: '\x1b[200~one\rtwo\rthree\x1b[201~', delayMs: 0 },
      { data: '\r', delayMs: PASTE_ENTER_DELAY_MS }
    ])
  })

  it('leaves Enter off a pasted block when asked to', () => {
    expect(sendKeystrokes('a\nb', false, true)).toEqual([
      { data: '\x1b[200~a\rb\x1b[201~', delayMs: 0 }
    ])
  })

  // A program that never asked for bracketed paste would print the markers.
  it('falls back to a raw write where the pane has not asked for pastes', () => {
    expect(sendKeystrokes('a\nb', true, false)).toEqual([{ data: 'a\nb\r', delayMs: 0 }])
  })

  // Otherwise the rest of the text would be typed live, newlines and all.
  it('strips paste markers out of the text so it cannot end the paste early', () => {
    const [first] = sendKeystrokes('a\x1b[201~\nrm -rf x\x1b[200~', false, true)
    expect(first!.data).toBe('\x1b[200~a\rrm -rf x\x1b[201~')
  })
})

describe('waitState', () => {
  const view = (o: Partial<WaitView>): WaitView => ({
    exists: true,
    exited: false,
    status: undefined,
    expecting: false,
    unanswered: false,
    ...o
  })

  it('reports a closed pane as gone whatever was asked for', () => {
    for (const t of ['idle', 'exit', 'approval', 'working', 'any'] as const) {
      expect(waitState(t, view({ exists: false }))).toBe('gone')
    }
  })

  it('treats an exited shell as reached for exit and any, and early otherwise', () => {
    expect(waitState('exit', view({ exited: true }))).toBe('reached')
    expect(waitState('any', view({ exited: true }))).toBe('reached')
    expect(waitState('idle', view({ exited: true, status: 'working' }))).toBe('exited')
    expect(waitState('approval', view({ exited: true }))).toBe('exited')
  })

  it('keeps waiting on exit while the shell is alive, whatever the agent does', () => {
    expect(waitState('exit', view({ status: 'waiting-input' }))).toBe('pending')
  })

  // The bug this exists for: a send to a waiting pane returning on that same
  // waiting, before the agent has read a word of it.
  it('ignores the previous turn while an agent is expected to report', () => {
    expect(waitState('idle', view({ status: 'waiting-input', expecting: true }))).toBe('pending')
    expect(waitState('any', view({ status: 'waiting-approval', expecting: true }))).toBe('pending')
  })

  it('settles as no-agent once a sent message has gone unanswered', () => {
    expect(waitState('idle', view({ status: 'waiting-input', unanswered: true }))).toBe('no-agent')
  })

  it('settles as no-agent where there is no agent and none coming', () => {
    expect(waitState('idle', view({}))).toBe('no-agent')
    expect(waitState('working', view({}))).toBe('no-agent')
    // ...but `any` still has the shell's exit to wait for.
    expect(waitState('any', view({}))).toBe('pending')
  })

  it.each([
    ['idle', 'waiting-input', 'reached'],
    ['idle', 'idle', 'reached'],
    ['idle', 'working', 'pending'],
    ['idle', 'waiting-approval', 'pending'],
    ['approval', 'waiting-approval', 'reached'],
    ['approval', 'waiting-input', 'pending'],
    ['working', 'working', 'reached'],
    ['working', 'waiting-input', 'pending'],
    ['any', 'waiting-input', 'reached'],
    ['any', 'waiting-approval', 'reached'],
    ['any', 'working', 'pending']
  ] as const)('--for %s with the pane %s is %s', (target, status, expected) => {
    expect(waitState(target, view({ status }))).toBe(expected)
  })
})

describe('sendExpectsReply', () => {
  const expects = (o: Partial<Parameters<typeof sendExpectsReply>[0]>): boolean =>
    sendExpectsReply({ enter: true, status: undefined, expecting: false, ...o })

  it('expects an agent that is sitting at its prompt to pick the message up', () => {
    expect(expects({ status: 'waiting-input' })).toBe(true)
    expect(expects({ status: 'idle' })).toBe(true)
  })

  it('expects nothing from a plain shell, unless an agent is already on its way', () => {
    expect(expects({ status: undefined })).toBe(false)
    expect(expects({ status: undefined, expecting: true })).toBe(true)
  })

  it('expects nothing without Enter — nothing was submitted', () => {
    expect(expects({ enter: false, status: 'waiting-input' })).toBe(false)
  })

  // A busy agent in one long tool call reports nothing new; the lapse would
  // call it absent and end `lc wait --for idle` as no-agent mid-turn.
  it('does not arm the lapse on an agent that is already working', () => {
    expect(expects({ status: 'working' })).toBe(false)
    expect(expects({ status: 'working', expecting: true })).toBe(false)
  })
})

describe('approvalKeystroke', () => {
  const asking = { target: 'p_1', agent: undefined, status: 'waiting-approval' as const }

  it('answers a Claude prompt: 1 for yes, Esc for no', () => {
    expect(approvalKeystroke({ ...asking, answer: 'yes' })).toEqual({ allow: true, data: '1' })
    expect(approvalKeystroke({ ...asking, answer: 'no' })).toEqual({ allow: true, data: '' })
    expect(approvalKeystroke({ ...asking, agent: 'claude', answer: 'yes' })).toEqual({
      allow: true,
      data: '1'
    })
  })

  // Read at the moment of writing: a prompt answered by hand a second ago is
  // gone, and a stale "1" would land in the input box as a message.
  it.each(['working', 'waiting-input', 'idle', undefined] as const)(
    'refuses when the pane is %s rather than asking',
    (status) => {
      const r = approvalKeystroke({ ...asking, status, answer: 'yes' })
      expect(r.allow).toBe(false)
    }
  )

  it('refuses an agent whose prompt keys nobody has checked, rather than guessing', () => {
    const r = approvalKeystroke({ ...asking, agent: 'codex', answer: 'yes' })
    expect(r.allow).toBe(false)
    if (!r.allow) expect(r.error).toContain('codex')
  })

  // A status guessed from the terminal going quiet is never grounds to type
  // an answer, whichever agent it is and whatever it says.
  it('refuses on an estimated status', () => {
    const r = approvalKeystroke({ ...asking, agent: 'claude', source: 'heuristic', answer: 'yes' })
    expect(r.allow).toBe(false)
    if (!r.allow) expect(r.error).toMatch(/estimated/)
  })
})

describe('interruptKeystroke', () => {
  it('is Esc for Claude, named or not, and ^C for anything else', () => {
    expect(interruptKeystroke(undefined)).toBe('')
    expect(interruptKeystroke(null)).toBe('')
    expect(interruptKeystroke('claude')).toBe('')
    expect(interruptKeystroke('codex')).toBe('')
  })
})

describe('lastMeaningfulLine', () => {
  it("skips a TUI's furniture to the last line that says something", () => {
    const screen = [
      '⏺ Edited src/auth.ts — 3 additions',
      '',
      '✻ Reticulating… (12s · esc to interrupt)',
      '╭──────────────────────────────╮',
      '│ >                            │',
      '╰──────────────────────────────╯',
      '  ? for shortcuts'
    ]
    expect(lastMeaningfulLine(screen)).toBe('✻ Reticulating… (12s · esc to interrupt)')
  })

  it('trims box edges and collapses runs of spaces', () => {
    expect(lastMeaningfulLine(['│ Running   tests │'])).toBe('Running tests')
  })

  it('takes a plain shell line as it is', () => {
    expect(lastMeaningfulLine(['PS C:\\repo> npm test', '  12 passed'])).toBe('12 passed')
  })

  it('is null for a screen with nothing on it but frames and prompts', () => {
    expect(lastMeaningfulLine([])).toBeNull()
    expect(lastMeaningfulLine(['', '╭───╮', '│ > │', '╰───╯', '$'])).toBeNull()
  })

  it('cuts a very long line short', () => {
    const line = lastMeaningfulLine(['x'.repeat(400)])!
    expect(line.length).toBe(160)
    expect(line.endsWith('…')).toBe(true)
  })
})

/**
 * A Claude Code screen as `lc read` returns it, mid-session: the answer, the
 * frame of the input box, the spinner it redraws, the shortcuts hint — and a
 * line repeated by a redraw.
 */
const CLAUDE_CAPTURE = [
  '╭───────────────────────────────────────────────╮',
  '│ ✻ Welcome to Claude Code!                      │',
  '╰───────────────────────────────────────────────╯',
  '',
  '> run the tests',
  '',
  '● Bash(npm test)',
  '  ⎿  12 passed',
  '  ⎿  12 passed',
  '',
  '',
  '● All 12 tests pass.',
  '  function ok() {',
  '    return true',
  '  }',
  '\x1b[2m✻ Thinking… (3s · esc to interrupt)\x1b[0m',
  '╭───────────────────────────────────────────────╮',
  '│ >                                              │',
  '╰───────────────────────────────────────────────╯',
  '  ? for shortcuts',
  ''
]

describe('cleanLines', () => {
  it('keeps the words of a Claude screen and drops its furniture', () => {
    expect(cleanLines(CLAUDE_CAPTURE)).toEqual([
      '✻ Welcome to Claude Code!',
      '',
      '> run the tests',
      '',
      '● Bash(npm test)',
      '  ⎿  12 passed',
      '',
      '● All 12 tests pass.',
      '  function ok() {',
      '    return true',
      '  }'
    ])
  })

  it('strips colour codes', () => {
    expect(cleanLines(['\x1b[32mgreen\x1b[0m text'])).toEqual(['green text'])
  })

  it('leaves a plain shell transcript as it was', () => {
    const shell = ['$ npm test', '', '  12 passed', '  0 failed']
    expect(cleanLines(shell)).toEqual(shell)
  })

  it('is empty for a screen with nothing on it', () => {
    expect(cleanLines([])).toEqual([])
    expect(cleanLines(['', '╭──╮', '│ > │', '╰──╯'])).toEqual([])
  })
})

describe('spawnGate', () => {
  const now = 100_000

  it('lets a spawn through while there is room', () => {
    expect(spawnGate({ recent: [], now, workers: 0 })).toEqual({ allow: true })
    expect(spawnGate({ recent: [now - 1000, now - 2000], now, workers: 3 })).toEqual({ allow: true })
  })

  it(`refuses the ${SPAWN_BURST + 1}th spawn inside the window, and says when to retry`, () => {
    const recent = [now - 9_000, now - 5_000, now - 1_000]
    const gate = spawnGate({ recent, now, workers: 3 })
    expect(gate.allow).toBe(false)
    if (!gate.allow) expect(gate.error).toMatch(/Try again in 1s/)
  })

  it('forgets spawns older than the window', () => {
    const recent = [now - SPAWN_WINDOW_MS - 1, now - SPAWN_WINDOW_MS, now - 1_000]
    expect(spawnGate({ recent, now, workers: 3 }).allow).toBe(true)
  })

  it(`stops a crew at ${MAX_CREW_WORKERS} workers`, () => {
    expect(spawnGate({ recent: [], now, workers: MAX_CREW_WORKERS - 1 }).allow).toBe(true)
    const gate = spawnGate({ recent: [], now, workers: MAX_CREW_WORKERS })
    expect(gate.allow).toBe(false)
    if (!gate.allow) expect(gate.error).toContain(String(MAX_CREW_WORKERS))
  })
})

describe('spawnBranch', () => {
  it('names the branch for the handle and the crew', () => {
    expect(spawnBranch('worker', 'c_ab12cd34', 1)).toBe('worker-ab12cd34')
  })

  it('numbers later tries, so a branch a closed worker left behind is stepped over', () => {
    expect(spawnBranch('worker', 'c_ab12cd34', 2)).toBe('worker-ab12cd34-2')
    expect(spawnBranch('worker', 'c_ab12cd34', 2)).not.toBe(spawnBranch('worker', 'c_ab12cd34', 1))
  })

  it('differs between two crews using the same handle', () => {
    expect(spawnBranch('dev', 'c_one', 1)).not.toBe(spawnBranch('dev', 'c_two', 1))
  })
})

describe('approveGate', () => {
  const lead = { id: 'c_a', handle: 'lead', lead: true as const }
  const worker = { id: 'c_a', handle: 'dev' }
  const gate = (o: Partial<Parameters<typeof approveGate>[0]>): ReturnType<typeof approveGate> =>
    approveGate({
      from: 'p_lead',
      fromCrew: lead,
      target: 'p_dev',
      targetCrew: worker,
      settings: { leadMayApprove: true },
      ...o
    })

  it("lets a crew's lead approve its own worker once the person allowed it", () => {
    expect(gate({})).toEqual({ allow: true })
  })

  // Off by default: the person never ticked the box.
  it.each([
    ['no settings at all', { settings: undefined }],
    ['settings without it', { settings: { strict: true } }],
    ['it turned off', { settings: { leadMayApprove: false } }]
  ])('refuses with %s', (_label, o) => {
    expect(gate(o).allow).toBe(false)
  })

  it('refuses anyone but the lead', () => {
    expect(gate({ from: 'p_other', fromCrew: { id: 'c_a', handle: 'qa' } }).allow).toBe(false)
    expect(gate({ fromCrew: undefined }).allow).toBe(false)
    expect(gate({ fromCrew: { id: 'c_b', handle: 'lead', lead: true } }).allow).toBe(false)
  })

  it('refuses a worker outside the crew, the caller itself, and an unknown caller', () => {
    expect(gate({ targetCrew: undefined }).allow).toBe(false)
    expect(gate({ target: 'p_lead', targetCrew: lead }).allow).toBe(false)
    expect(gate({ from: undefined }).allow).toBe(false)
  })
})

describe('pauseGate', () => {
  const a = { id: 'c_a', handle: 'lead', lead: true as const }
  const b = { id: 'c_b', handle: 'dev' }

  it('says nothing about crews that are not paused, or panes in none', () => {
    expect(pauseGate({ fromCrew: a, targetCrew: b, settings: {} })).toEqual({ allow: true })
    expect(pauseGate({ fromCrew: undefined, targetCrew: undefined, settings: {} })).toEqual({
      allow: true
    })
  })

  it('refuses while either crew is paused', () => {
    const settings = { c_a: { paused: true } }
    expect(pauseGate({ fromCrew: a, targetCrew: undefined, settings }).allow).toBe(false)
    expect(pauseGate({ fromCrew: undefined, targetCrew: a, settings }).allow).toBe(false)
    expect(pauseGate({ fromCrew: b, targetCrew: b, settings }).allow).toBe(true)
  })
})
