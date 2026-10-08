import { describe, expect, test } from 'bun:test'
import { normalizeOptions } from '../src/options.js'

const taskProvider = {
  async create() {
    throw new Error('not used')
  },
  async get() {
    return undefined
  },
  async update() {
    return false
  },
  async requestInput() {
    return false
  },
  async cancel() {
    return false
  }
}

describe('extension numeric options', () => {
  test('rejects invalid task timing values during construction', () => {
    for (const defaultTtl of [Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5]) {
      expect(() =>
        normalizeOptions({ extensions: { tasks: { provider: taskProvider, defaultTtl } } })
      ).toThrow('defaultTtl')
    }
    for (const pollInterval of [Number.NaN, Number.POSITIVE_INFINITY, -1, 0, 1.5]) {
      expect(() =>
        normalizeOptions({ extensions: { tasks: { provider: taskProvider, pollInterval } } })
      ).toThrow('pollInterval')
    }
  })

  test('rejects invalid auth clock skew during construction', () => {
    for (const clockSkewSeconds of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      expect(() =>
        normalizeOptions({
          extensions: {
            auth: {
              resource: 'https://mcp.example.com/mcp',
              authorizationServers: ['https://auth.example.com'],
              verifyAccessToken: async () => {
                throw new Error('not used')
              },
              clockSkewSeconds
            }
          }
        })
      ).toThrow('clockSkewSeconds')
    }
  })

  test('bounds event timer-backed delays without restricting absolute expiries', () => {
    const maximumTimerDelay = 2_147_483_647
    const cursor = { signingKey: '0123456789abcdef0123456789abcdef' }
    const provider = { durability: 'durable' } as never
    const normalizeEvents = (events: Record<string, unknown>) =>
      normalizeOptions({
        transport: { protocolVersions: ['2025-11-25'] },
        extensions: { events: { cursor, ...events } }
      })

    expect(() => normalizeEvents({ heartbeatMs: 30_000 })).not.toThrow()
    expect(() => normalizeEvents({ heartbeatMs: 30_001 })).toThrow(RangeError)

    for (const field of ['pollIntervalMs', 'pollLeaseMs'] as const) {
      expect(() => normalizeEvents({ [field]: maximumTimerDelay })).not.toThrow()
      expect(() => normalizeEvents({ [field]: maximumTimerDelay + 1 })).toThrow(RangeError)
    }

    for (const field of ['requestTimeoutMs', 'maxRetryElapsedMs', 'retryBaseMs'] as const) {
      expect(() =>
        normalizeEvents({ webhook: { provider, [field]: maximumTimerDelay } })
      ).not.toThrow()
      expect(() =>
        normalizeEvents({ webhook: { provider, [field]: maximumTimerDelay + 1 } })
      ).toThrow(RangeError)
    }

    expect(() =>
      normalizeEvents({
        webhook: {
          provider,
          verificationTtlMs: maximumTimerDelay + 1,
          challengeRateLimitMs: maximumTimerDelay + 1
        }
      })
    ).not.toThrow()

    const defaults = normalizeEvents({}).extensions.events
    expect(defaults?.heartbeatMs).toBe(15_000)
    expect(defaults?.pollIntervalMs).toBe(5_000)
    expect(defaults?.pollLeaseMs).toBe(15_000)
  })
})

describe('modern core options', () => {
  test('requires strong signing keys and durable single-use continuations', () => {
    expect(() => normalizeOptions({ core: { continuation: { signingKey: 'short' } } })).toThrow(
      'at least 32 bytes'
    )
    expect(() =>
      normalizeOptions({
        core: {
          continuation: {
            signingKey: '0123456789abcdef0123456789abcdef',
            singleUse: true
          }
        }
      })
    ).toThrow('application provider')
  })

  test('rejects invalid pagination, cache, and subscription bounds', () => {
    const signingKey = '0123456789abcdef0123456789abcdef'
    expect(() => normalizeOptions({ core: { pagination: { signingKey, pageSize: 0 } } })).toThrow(
      'pageSize'
    )
    expect(() => normalizeOptions({ core: { cache: { default: { ttlMs: -1 } } } })).toThrow(
      'Cache ttlMs'
    )
    expect(() =>
      normalizeOptions({
        core: {
          subscriptions: {
            heartbeatMs: 0,
            provider: { subscribe: async function* () {} }
          }
        }
      })
    ).toThrow('heartbeatMs')
  })
})

describe('Skills options', () => {
  test('validates revision, cache, and cursor configuration', () => {
    expect(() => normalizeOptions({ extensions: { skills: { version: 'bad' as any } } })).toThrow(
      'Unsupported skills specification version'
    )
    expect(() =>
      normalizeOptions({ extensions: { skills: { cache: { cacheScope: 'public', ttlMs: -1 } } } })
    ).toThrow('Skills cache ttlMs')
    expect(() =>
      normalizeOptions({
        extensions: {
          skills: { pagination: { pageSize: 0, signingKey: '0123456789abcdef0123456789abcdef' } }
        }
      })
    ).toThrow('Skills pagination pageSize')
  })

  test('allows static providers without a directory callback', () => {
    const provider = {
      list: () => ({ skills: [] }),
      get: () => null,
      read: () => null
    }
    expect(() =>
      normalizeOptions({ extensions: { skills: { directoryRead: true, provider } } })
    ).not.toThrow()
  })
})
