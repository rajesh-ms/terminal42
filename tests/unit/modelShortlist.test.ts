import { describe, it, expect } from 'vitest'
import {
  FALLBACK_MODELS,
  compareModelRecency,
  parseModelVersion,
  shortlistModels
} from '../../src/shared/models'

describe('parseModelVersion', () => {
  it('separates the version from the family', () => {
    expect(parseModelVersion('claude-opus-4.8')).toEqual({
      family: 'claude-opus',
      version: [4, 8]
    })
  })

  it('keeps variant suffixes in the family', () => {
    expect(parseModelVersion('gpt-5.6-sol').family).toBe('gpt-sol')
    expect(parseModelVersion('gemini-3.7-flash').family).toBe('gemini-flash')
  })

  it('treats a bare major version as a version', () => {
    expect(parseModelVersion('claude-opus-5').version).toEqual([5])
  })

  it('survives an ID with no version at all', () => {
    expect(parseModelVersion('some-new-model')).toEqual({
      family: 'some-new-model',
      version: []
    })
  })
})

describe('compareModelRecency', () => {
  it('ranks a higher major above a higher minor', () => {
    // The bug this exists to prevent: string ordering put "4.6" above "5".
    expect(compareModelRecency('claude-opus-5', 'claude-opus-4.6')).toBeLessThan(0)
    expect(compareModelRecency('gemini-3.7-flash', 'gemini-3.1-pro-preview')).toBeLessThan(0)
  })

  it('ranks minor versions numerically, not lexically', () => {
    // "5.10" beats "5.9" numerically but loses as text.
    expect(compareModelRecency('gpt-5.10', 'gpt-5.9')).toBeLessThan(0)
  })

  it('treats a missing component as zero', () => {
    expect(compareModelRecency('gpt-5.1', 'gpt-5')).toBeLessThan(0)
  })

  it('is a total order with no ties between distinct ids', () => {
    const ids = FALLBACK_MODELS.map((m) => m.id)
    for (const a of ids) {
      for (const b of ids) {
        if (a === b) continue
        expect(compareModelRecency(a, b)).not.toBe(0)
      }
    }
  })
})

describe('shortlistModels', () => {
  const short = shortlistModels(FALLBACK_MODELS)

  it('cuts the list down substantially', () => {
    expect(short.length).toBeLessThan(FALLBACK_MODELS.length)
    expect(short.length).toBeGreaterThan(0)
  })

  it('never shows more than the cap per provider', () => {
    const counts = new Map<string, number>()
    for (const m of short) counts.set(m.group, (counts.get(m.group) ?? 0) + 1)
    for (const n of counts.values()) expect(n).toBeLessThanOrEqual(3)
  })

  it('keeps the newest model of each provider', () => {
    expect(short.map((m) => m.id)).toContain('claude-opus-5.5')
    expect(short.map((m) => m.id)).toContain('gemini-3.8-flash')
    expect(short.map((m) => m.id)).toContain('grok-4.7')
  })

  it('keeps distinct families rather than three generations of one', () => {
    // Spending all of Anthropic's slots on Opus would hide Sonnet entirely.
    const ids = short.map((m) => m.id)
    expect(ids).toContain('claude-sonnet-5.5')
    expect(ids).not.toContain('claude-opus-4.7')
  })

  it('drops superseded revisions of the same family', () => {
    const ids = short.map((m) => m.id)
    expect(ids).not.toContain('gemini-3.5-flash')
    expect(ids).not.toContain('grok-4.5')
  })

  it('pins the current selection even when it is superseded', () => {
    const ids = shortlistModels(FALLBACK_MODELS, 3, 'claude-opus-4.6').map((m) => m.id)
    expect(ids).toContain('claude-opus-4.6')
  })

  it('does not duplicate a selection that is already shortlisted', () => {
    const ids = shortlistModels(FALLBACK_MODELS, 3, 'claude-opus-5').map((m) => m.id)
    expect(ids.filter((id) => id === 'claude-opus-5')).toHaveLength(1)
  })

  it('ignores a selection that is not in the catalog', () => {
    expect(() => shortlistModels(FALLBACK_MODELS, 3, 'retired-model-9')).not.toThrow()
  })

  it('groups providers in the configured order', () => {
    const groups = [...new Set(short.map((m) => m.group))]
    expect(groups).toEqual(['Anthropic', 'OpenAI', 'Google', 'xAI', 'Microsoft'])
  })

  it('handles an empty catalog', () => {
    expect(shortlistModels([])).toEqual([])
  })

  it('ranks an unreleased future model above todays newest', () => {
    // The catalog is fetched live, so this must work with no code change.
    const future = { id: 'claude-opus-6', label: 'Claude Opus 6', group: 'Anthropic' }
    const ids = shortlistModels([...FALLBACK_MODELS, future]).map((m) => m.id)
    expect(ids).toContain('claude-opus-6')
    expect(ids).not.toContain('claude-opus-5')
  })
})
