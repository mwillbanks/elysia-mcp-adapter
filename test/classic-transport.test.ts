import { describe, expect, it, mock } from 'bun:test'
import { Elysia } from 'elysia'
import { mcp } from '../src/index.js'
import { modernRpc, request } from './helpers.js'

const classic = '2025-11-25'
const modern = '2026-07-28'
const modernMeta = { 'io.modelcontextprotocol/protocolVersion': modern }
const initialize = { capabilities: {}, clientInfo: { name: 'classic-client', version: '1' } }
const accept = 'application/json, text/event-stream'

function message(method: string, params?: Record<string, unknown>) {
  return { jsonrpc: '2.0', id: 1, method, params }
}

function post(app: Elysia, payload: unknown, headers: Record<string, string> = {}) {
  return request(app, 'POST', { accept, ...headers }, JSON.stringify(payload))
}

describe('classic protocol without version headers', () => {
  it('initializes, accepts notifications, lists tools, and invokes a tool on default transport', async () => {
    const run = mock(() => 'hello')
    const app = new Elysia().use(mcp()).mcpTool('greet', run)
    const initialized = await post(
      app,
      message('initialize', { ...initialize, protocolVersion: classic })
    )
    expect(initialized.status).toBe(200)
    expect(await initialized.json()).toMatchObject({ id: 1, result: { protocolVersion: classic } })

    const notification = await post(app, { jsonrpc: '2.0', method: 'notifications/initialized' })
    expect(notification.status).toBe(202)
    expect(await notification.text()).toBe('')

    const listed = await post(app, message('tools/list'))
    expect(listed.status).toBe(200)
    expect(await listed.json()).toMatchObject({ id: 1, result: { tools: [{ name: 'greet' }] } })

    const called = await post(app, message('tools/call', { name: 'greet', arguments: {} }))
    expect(called.status).toBe(200)
    expect(await called.json()).toMatchObject({
      id: 1,
      result: { content: [{ type: 'text', text: 'hello' }] }
    })
    expect(run).toHaveBeenCalledTimes(1)
  })

  it.each([{}, { protocolVersion: '1999-01-01' }, { protocolVersion: modern }])(
    'falls back to the enabled classic revision for initialize proposal %j',
    async (proposal) => {
      const app = new Elysia().use(mcp({ transport: { protocolVersions: [classic] } }))
      const response = await post(app, message('initialize', { ...initialize, ...proposal }))
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ result: { protocolVersion: classic } })
    }
  )

  it('rejects classic traffic when only modern is enabled', async () => {
    const app = new Elysia().use(mcp({ transport: { protocolVersions: [modern] } }))
    for (const payload of [message('initialize', initialize), message('tools/list')]) {
      const response = await post(app, payload)
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({
        id: 1,
        error: { code: -32022, data: { supported: [modern], requested: classic } }
      })
    }

    const explicitClassic = await post(app, message('tools/list'), {
      'mcp-protocol-version': classic
    })
    expect(explicitClassic.status).toBe(400)
    expect(await explicitClassic.json()).toMatchObject({
      id: null,
      error: { code: -32022, data: { supported: [modern], requested: classic } }
    })

    const discovery = await modernRpc(app, 'server/discover')
    expect(discovery.status).toBe(200)
    expect(discovery.body.result.supportedVersions).toEqual([modern])
  })

  it('keeps classic parse errors distinct from modern error envelopes', async () => {
    const app = new Elysia().use(mcp())
    const legacyResponse = await request(app, 'POST', {}, '{')
    expect(legacyResponse.status).toBe(400)
    expect(await legacyResponse.json()).toMatchObject({ id: null, error: { code: -32700 } })

    const modernResponse = await request(app, 'POST', { 'mcp-protocol-version': modern }, '{')
    expect(modernResponse.status).toBe(400)
    const body = await modernResponse.json()
    expect(body).toMatchObject({ error: { code: -32700 } })
    expect(body).not.toHaveProperty('id')

    const incompleteModern = await post(app, {
      ...message('tools/list', { _meta: modernMeta }),
      id: null
    })
    expect(incompleteModern.status).toBe(400)
    expect(await incompleteModern.json()).not.toHaveProperty('id')
  })

  it('uses the request era for invalid subscription IDs', async () => {
    const app = new Elysia().use(mcp())
    for (const notifications of [
      undefined,
      { taskIds: [] },
      { taskIds: [], toolsListChanged: true }
    ]) {
      const legacyResponse = await post(app, {
        ...message('subscriptions/listen', { notifications }),
        id: null
      })
      expect(legacyResponse.status).toBe(400)
      expect(await legacyResponse.json()).toMatchObject({ id: null, error: { code: -32600 } })

      const modernResponse = await post(app, {
        ...message('subscriptions/listen', { notifications, _meta: modernMeta }),
        id: null
      })
      expect(modernResponse.status).toBe(400)
      const body = await modernResponse.json()
      expect(body).toMatchObject({ error: { code: -32600 } })
      expect(body).not.toHaveProperty('id')
    }
  })

  it('rejects incomplete modern requests and enforces modern routing and Accept', async () => {
    const app = new Elysia().use(mcp()).mcpTool('greet', () => 'hello')
    const params = { name: 'greet', arguments: {} }
    const incomplete = [
      await post(app, message('tools/call', params), { 'mcp-protocol-version': modern }),
      await post(app, message('tools/call', { ...params, _meta: modernMeta })),
      await post(app, message('tools/call', { ...params, _meta: modernMeta }), {
        'mcp-protocol-version': classic
      })
    ]
    for (const response of incomplete) {
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({ error: { code: -32020 } })
    }
    const invalidHeaders: Record<string, string>[] = [
      { 'mcp-method': 'tools/list' },
      { 'mcp-name': 'other' },
      { accept: 'application/json' }
    ]
    for (const headers of invalidHeaders) {
      const response = await modernRpc(app, 'tools/call', params, headers)
      expect(response.status).toBe(400)
      expect(response.body.error.code).toBe(-32020)
    }

    const response = await modernRpc(app, 'tools/call', params)
    expect(response.status).toBe(200)
    expect(response.body.result.resultType).toBe('complete')
  })

  it('accepts classic batches and rejects modern batches before dispatch', async () => {
    const run = mock(() => 'hello')
    const app = new Elysia().use(mcp()).mcpTool('greet', run)
    const call = message('tools/call', { name: 'greet', arguments: {} })
    const legacyBatch = await post(app, [message('ping'), { ...call, id: 2 }])
    expect(legacyBatch.status).toBe(200)
    expect(await legacyBatch.json()).toMatchObject([
      { id: 1, result: {} },
      { id: 2, result: { content: [{ type: 'text', text: 'hello' }] } }
    ])
    expect(run).toHaveBeenCalledTimes(1)

    const emptyBatch = await post(app, [])
    expect(emptyBatch.status).toBe(400)
    expect(await emptyBatch.json()).toMatchObject({ id: null, error: { code: -32600 } })

    const modernBatch = await post(app, [call], { 'mcp-protocol-version': modern })
    const mixedBatch = await post(app, [call, message('tools/list', { _meta: modernMeta })])
    for (const response of [modernBatch, mixedBatch]) {
      expect(response.status).toBe(400)
      const body = await response.json()
      expect(body).toMatchObject({ error: { code: -32600 } })
      expect(body).not.toHaveProperty('id')
    }
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('applies opt-in GET and DELETE only to classic traffic', async () => {
    const transport = { enableGetSse: true, enableDeleteSession: true }
    const app = new Elysia().use(mcp({ transport }))
    const modernOnly = new Elysia().use(
      mcp({ transport: { ...transport, protocolVersions: [modern] } })
    )
    const get = await request(app, 'GET')
    expect(get.status).toBe(200)
    expect(get.headers.get('content-type')).toBe('text/event-stream')
    expect(await get.text()).toBe('')
    expect((await request(app, 'DELETE')).status).toBe(202)
    for (const method of ['GET', 'DELETE']) {
      expect((await request(app, method, { 'mcp-protocol-version': modern })).status).toBe(405)
      expect((await request(modernOnly, method)).status).toBe(405)
    }
  })
})
