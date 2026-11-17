import { describe, expect, it } from 'vitest'
import { agentOptions } from './agentPicker'

describe('agentOptions', () => {
  it('lists every agent, plainly when it was found', () => {
    const rows = agentOptions({ claude: true, codex: true, gemini: true, shell: true })
    expect(rows.map((r) => r.id)).toEqual(['claude', 'codex', 'gemini', 'shell'])
    expect(rows.find((r) => r.id === 'claude')).toEqual({ id: 'claude', label: 'Claude Code', note: null })
  })

  it('dims an agent whose command was not found, but keeps it', () => {
    const codex = agentOptions({ codex: false }).find((r) => r.id === 'codex')!
    expect(codex.label).toBe('Codex (not found)')
    expect(codex.note).toMatch(/codex.*not found on PATH/)
  })

  it('says an adapter has not been tried', () => {
    const gemini = agentOptions({ gemini: true }).find((r) => r.id === 'gemini')!
    expect(gemini.label).toBe('Gemini (untested)')
    expect(gemini.note).toMatch(/not yet tried/)
  })

  it('never calls the shell missing', () => {
    expect(agentOptions({ shell: false }).find((r) => r.id === 'shell')!.note).toBeNull()
  })

  it('does not dim what it was not told about', () => {
    expect(agentOptions({}).find((r) => r.id === 'codex')!.note).toBeNull()
  })
})
