import { describe, expect, it } from 'bun:test'
import { Elysia } from 'elysia'
import { mcp } from '../src/index.js'
import { request, rpc } from './helpers.js'

const server = { name: 'test', version: '1.0.0' } as const

describe('transport', () => {
  it('negotiates initialize with capabilities and server info', async () => {
    const app = new Elysia().use(
      mcp({
        server: { ...server, instructions: 'be careful' },
        transport: { validateOrigin: false }
      })
    )

    const { body } = await rpc(app, 'initialize')

    expect(body.result.protocolVersion).toBe('2025-11-25')
    expect(body.result.serverInfo).toMatchObject({ name: 'test', version: '1.0.0' })
    expect(body.result.capabilities).toHaveProperty('tools')
    expect(body.result.instructions).toBe('be careful')
  })

  it('reserves protocolVersion for legacy initialize', () => {
    expect(() =>
      mcp({
        transport: {
          protocolVersion: '2026-07-28',
          protocolVersions: ['2026-07-28', '2025-11-25']
        }
      })
    ).toThrow('reserved for legacy initialize')
  })

  it('answers ping', async () => {
    const app = new Elysia().use(mcp({ server, transport: { validateOrigin: false } }))
    const { body } = await rpc(app, 'ping')
    expect(body.result).toEqual({})
  })

  it('accepts notifications with 202 and no body', async () => {
    const app = new Elysia().use(mcp({ server, transport: { validateOrigin: false } }))
    const response = await request(
      app,
      'POST',
      { 'mcp-protocol-version': '2025-11-25' },
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })
    )
    expect(response.status).toBe(202)
  })

  it('returns method-not-found for unknown methods', async () => {
    const app = new Elysia().use(mcp({ server, transport: { validateOrigin: false } }))
    const { body } = await rpc(app, 'does/not-exist')
    expect(body.error.code).toBe(-32601)
  })

  it('returns a parse error for malformed JSON', async () => {
    const app = new Elysia().use(mcp({ server, transport: { validateOrigin: false } }))
    const response = await request(
      app,
      'POST',
      { 'mcp-protocol-version': '2025-11-25' },
      '{ not json'
    )
    const body = (await response.json()) as any
    expect(response.status).toBe(400)
    expect(body.error.code).toBe(-32700)
    expect(body.id).toBeNull()
  })

  it('default-denies browser origins and returns 405 for disabled GET/DELETE', async () => {
    const app = new Elysia().use(mcp({ server }))

    const denied = await request(
      app,
      'POST',
      { origin: 'http://evil.example' },
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })
    )
    expect(denied.status).toBe(403)

    const sse = await request(app, 'GET')
    expect(sse.status).toBe(405)

    const del = await request(app, 'DELETE')
    expect(del.status).toBe(405)
  })

  it('allows configured origins', async () => {
    const app = new Elysia().use(
      mcp({ server, transport: { allowedOrigins: ['http://trusted.example'] } })
    )

    const ok = await request(
      app,
      'POST',
      { origin: 'http://trusted.example', 'mcp-protocol-version': '2025-11-25' },
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })
    )
    expect(ok.status).toBe(200)
  })
})
