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
})
