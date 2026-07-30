import { describe, expect, test } from 'bun:test'
import { Elysia } from 'elysia'
import { MCP_APPS_RESOURCE_MIME_TYPE, mcp } from '../src/index.js'
import { modernRpc, rpc } from './helpers.js'

describe('modern result codecs', () => {
  test('adds the required result discriminators and cache policy', async () => {
    const app = new Elysia()
      .use(mcp({ allowedRoutes: [] }))
      .mcpTool('echo', ({ value }: any) => ({ value }))
      .mcpResource('config://runtime', () => ({ ok: true }), {
        name: 'runtime',
        mimeType: 'application/json'
      })
      .mcpResource('users://{id}', ({ variables }) => variables, {
        name: 'user',
        mimeType: 'application/json'
      })
      .mcpPrompt('greet', ({ name }: any) => `Hello ${name}`, {
        argsSchema: {
          type: 'object',
          properties: { name: { type: 'string' } },
          required: ['name']
        }
      })

    for (const [method, params] of [
      ['tools/list', {}],
      ['resources/list', {}],
      ['resources/templates/list', {}],
      ['resources/read', { uri: 'config://runtime' }],
      ['prompts/list', {}]
    ] as const) {
      const response = await modernRpc(app, method, params)
      expect(response.body.result).toMatchObject({
        cacheScope: 'private',
        resultType: 'complete',
        ttlMs: 0
      })
    }

    const called = await modernRpc(app, 'tools/call', {
      name: 'echo',
      arguments: { value: 'ok' }
    })
    expect(called.body.result.resultType).toBe('complete')

    const prompt = await modernRpc(app, 'prompts/get', {
      name: 'greet',
      arguments: { name: 'Ada' }
    })
    expect(prompt.body.result.resultType).toBe('complete')
  })
})

describe('modern request envelope validation', () => {
  test('cannot downgrade modern headers through body metadata', async () => {
    let invoked = false
    const app = new Elysia().use(mcp({ allowedRoutes: [] })).mcpTool('danger', () => {
      invoked = true
      return 'unsafe'
    })
    const response = await app.handle(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'mcp-protocol-version': '2026-07-28',
          'mcp-method': 'tools/list'
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'danger',
            _meta: {
              'io.modelcontextprotocol/protocolVersion': '2025-11-25'
            }
          }
        })
      })
    )

    expect(response.status).toBe(400)
    expect(((await response.json()) as any).error.code).toBe(-32020)
    expect(invoked).toBe(false)
  })

  test('decodes encoded Mcp-Name values and requires client capabilities', async () => {
    const name = 'weather/東京'
    const app = new Elysia().use(mcp({ allowedRoutes: [] })).mcpTool(name, () => 'ok')
    const encoded = `=?base64?${Buffer.from(name).toString('base64')}?=`
    const response = await modernRpc(app, 'tools/call', { name }, { 'mcp-name': encoded })
    expect(response.status).toBe(200)

    const missingCapabilities = await app.handle(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'mcp-protocol-version': '2026-07-28',
          'mcp-method': 'tools/list'
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list',
          params: {
            _meta: {
              'io.modelcontextprotocol/protocolVersion': '2026-07-28'
            }
          }
        })
      })
    )
    expect(missingCapabilities.status).toBe(400)
    expect(((await missingCapabilities.json()) as any).error.code).toBe(-32020)
  })
})

describe('mirrored tool parameter headers', () => {
  test('validates nested, encoded, missing, and mismatched values before invocation', async () => {
    let invocations = 0
    const app = new Elysia().use(mcp({ allowedRoutes: [] })).mcpTool(
      'tenant.echo',
      (input) => {
        invocations += 1
        return input
      },
      {
        inputSchema: {
          type: 'object',
          properties: {
            routing: {
              type: 'object',
              properties: {
                tenant: {
                  type: 'string',
                  'x-mcp-header': 'Tenant'
                }
              }
            }
          }
        }
      }
    )

    const tenant = '東京'
    const encoded = `=?base64?${Buffer.from(tenant).toString('base64')}?=`
    const valid = await modernRpc(
      app,
      'tools/call',
      { name: 'tenant.echo', arguments: { routing: { tenant } } },
      { 'mcp-param-tenant': encoded }
    )
    expect(valid.status).toBe(200)
    expect(invocations).toBe(1)

    for (const headers of [
      {} as Record<string, string>,
      { 'mcp-param-tenant': 'other' },
      { 'mcp-param-tenant': '=?base64?not-valid!?=' }
    ]) {
      const invalid = await modernRpc(
        app,
        'tools/call',
        { name: 'tenant.echo', arguments: { routing: { tenant } } },
        headers
      )
      expect(invalid.status).toBe(400)
      expect(invalid.body.error.code).toBe(-32020)
    }
    expect(invocations).toBe(1)
  })
})

describe('Apps visibility negotiation', () => {
  test('keeps legacy app tools host-visible and validates modern MIME support', async () => {
    const uri = 'ui://weather/app.html'
    const app = new Elysia()
      .use(mcp({ allowedRoutes: [], extensions: { apps: {} } }))
      .mcpTool('weather.refresh', () => 'ok', {
        app: { resourceUri: uri, visibility: ['app'] }
      })
      .mcpResource(
        uri,
        () => ({
          contents: [
            {
              uri,
              mimeType: MCP_APPS_RESOURCE_MIME_TYPE,
              text: '<!doctype html><html><body>Weather</body></html>'
            }
          ]
        }),
        { mimeType: MCP_APPS_RESOURCE_MIME_TYPE }
      )

    expect((await rpc(app, 'tools/list')).body.result.tools).toHaveLength(1)
    expect((await modernRpc(app, 'tools/list')).body.result.tools).toHaveLength(0)

    const negotiated = await modernRpc(app, 'tools/list', {
      _meta: {
        'io.modelcontextprotocol/clientCapabilities': {
          extensions: {
            'io.modelcontextprotocol/ui': {
              mimeTypes: [MCP_APPS_RESOURCE_MIME_TYPE]
            }
          }
        }
      }
    })
    expect(negotiated.body.result.tools).toHaveLength(1)
  })
})
