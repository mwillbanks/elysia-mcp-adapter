import { describe, expect, test } from 'bun:test'
import { resolveGovernedDraftRevision } from '../src/extensions/revision-policy.js'

describe('governed draft revision policy', () => {
  const migration = 'Update the wire contract and select "current".'

  test('allows only the current draft and reports how to migrate exact obsolete pins', () => {
    const initial = { current: 'pin-a', migration }
    expect(resolveGovernedDraftRevision('Example draft', 'current', initial)).toBe('pin-a')
    const updated = { current: 'pin-b', superseded: ['pin-a'], migration }
    expect(resolveGovernedDraftRevision('Example draft', undefined, updated)).toBe('pin-b')
    expect(resolveGovernedDraftRevision('Example draft', 'pin-b', updated)).toBe('pin-b')
    expect(() => resolveGovernedDraftRevision('Example draft', 'pin-a', updated)).toThrow(
      `revision "pin-a" was superseded. ${migration}`
    )
    expect(() => resolveGovernedDraftRevision('Example draft', 'unknown', updated)).toThrow(
      `Unsupported Example draft revision "unknown". ${migration}`
    )
  })

  test('rejects both default and exact configuration after removal', () => {
    const removed = {
      current: null,
      superseded: ['pin-a', 'pin-b'],
      migration: 'Remove the experimental configuration.'
    }
    for (const selector of [undefined, 'current', 'pin-a', 'pin-b']) {
      expect(() => resolveGovernedDraftRevision('Example draft', selector, removed)).toThrow(
        'Example draft support was removed. Remove the experimental configuration.'
      )
    }
  })
})
