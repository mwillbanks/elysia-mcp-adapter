import { describe, expect, test } from 'bun:test'
import { Elysia, t } from 'elysia'
import { getMcpRegistry, mcp } from '../src/index.js'
import { normalizeOptions } from '../src/options.js'
import { onRegistryChange } from '../src/state.js'
import { modernRpc } from './helpers.js'

describe('companion prompts', () => {
  test('renders instructions for an App launch tool without executing it', async () => {
    let calls = 0
    const app = new Elysia()
      .use(mcp({ allowedRoutes: [], extensions: { apps: {} } }))
      .mcpResource('ui://reports/view', () => '<!doctype html><html></html>', {
        mimeType: 'text/html;profile=mcp-app'
      })
      .mcpTool(
        'launch-reports',
        () => {
          calls++
          return 'Ready'
        },
        {
          app: { resourceUri: 'ui://reports/view' },
          prompt: {
            name: 'open-reports',
            title: 'Open reports',
            description: 'Open the reports App',
            argsSchema: t.Object({ period: t.String() }),
            render: ({ period }, { toolName }) => `Call ${toolName} for ${period}.`
          }
        }
      )

    const list = await modernRpc(app, 'prompts/list')
    expect(list.body.result.prompts).toEqual([
      {
        name: 'open-reports',
        title: 'Open reports',
        description: 'Open the reports App',
        arguments: [{ name: 'period', required: true }]
      }
    ])
    const params = { name: 'open-reports', arguments: { period: 'November' } }
    const prompt = await modernRpc(app, 'prompts/get', params)
    expect(prompt.body.result.messages[0].content.text).toBe('Call launch-reports for November.')
    const invalid = await modernRpc(app, 'prompts/get', { ...params, arguments: {} })
    expect(invalid.body.error).toBeDefined()
    expect(calls).toBe(0)
  })

  test('uses resolved route tool names and reserves standalone prompt names', async () => {
    let calls = 0
    const app = new Elysia()
      .use(mcp({ onNameCollision: 'suffix' }))
      .mcpTool('reports', () => 'Explicit tool')
      .mcpPrompt('reports_2', () => 'Standalone prompt')
      .get(
        '/reports',
        () => {
          calls++
          return 'Route tool'
        },
        {
          mcp: {
            kind: 'tool',
            name: 'reports',
            prompt: {
              arguments: [{ name: 'period', required: true }],
              render: ({ period }: Record<string, unknown>, { toolName }: { toolName: string }) =>
                `Call ${toolName} for ${period}.`
            }
          }
        }
      )

    const invalid = await modernRpc(app, 'prompts/get', { name: 'reports_2_2' })
    expect(invalid.body.error).toBeDefined()
    const companion = await modernRpc(app, 'prompts/get', {
      name: 'reports_2_2',
      arguments: { period: 'November' }
    })
    expect(companion.body.result.messages[0].content.text).toBe('Call reports_2 for November.')
    const standalone = await modernRpc(app, 'prompts/get', { name: 'reports_2' })
    expect(standalone.body.result.messages[0].content.text).toBe('Standalone prompt')
    expect(calls).toBe(0)
    await modernRpc(app, 'tools/call', { name: 'reports_2' })
    expect(calls).toBe(1)
  })

  test('rejects duplicate prompt names and companions on App-only tools', async () => {
    const duplicate = new Elysia()
      .use(mcp({ allowedRoutes: [] }))
      .mcpPrompt('reports', () => 'Standalone')
      .mcpTool('reports', () => 'Tool', { prompt: { render: () => 'Companion' } })
    const duplicateResult = await modernRpc(duplicate, 'prompts/list')
    expect(duplicateResult.body.error).toBeDefined()

    const appOnly = new Elysia()
      .use(mcp({ allowedRoutes: [], extensions: { apps: {} } }))
      .mcpTool('reports', () => 'Tool', {
        app: { resourceUri: 'ui://reports/view', visibility: ['app'] },
        prompt: { render: () => 'Companion' }
      })
    const appOnlyResult = await modernRpc(appOnly, 'prompts/list')
    expect(appOnlyResult.body.error).toBeDefined()
  })

  test('enforces the linked tool scopes on list, get, and completion', async () => {
    const resource = 'https://api.example.com/mcp'
    const app = new Elysia()
      .use(
        mcp({
          allowedRoutes: [],
          extensions: {
            auth: {
              resource,
              authorizationServers: ['https://auth.example.com'],
              verifyAccessToken: async (token) => ({
                tokenType: 'access_token',
                subject: token,
                issuer: 'https://auth.example.com',
                audience: resource,
                scopes: token === 'admin' ? ['reports:read'] : [],
                expiresAt: 4_000_000_000
              })
            }
          }
        })
      )
      .mcpTool('reports', () => 'Tool', {
        authorization: { requiredScopes: ['reports:read'] },
        prompt: {
          arguments: [{ name: 'period' }],
          complete: () => ({ values: ['November'] }),
          render: () => 'Call reports.'
        }
      })

    const user = { authorization: 'Bearer user' }
    const admin = { authorization: 'Bearer admin' }
    const get = { name: 'reports' }
    const complete = {
      ref: { type: 'ref/prompt', name: 'reports' },
      argument: { name: 'period', value: 'Nov' }
    }

    expect((await modernRpc(app, 'prompts/list', {}, user)).body.result.prompts).toEqual([])
    const adminList = await modernRpc(app, 'prompts/list', {}, admin)
    expect(adminList.body.result.prompts[0].name).toBe('reports')
    expect((await modernRpc(app, 'prompts/get', get, user)).status).toBe(403)
    expect((await modernRpc(app, 'completion/complete', complete, user)).status).toBe(403)
    expect((await modernRpc(app, 'prompts/get', get, admin)).body.result.messages).toHaveLength(1)
    const completion = await modernRpc(app, 'completion/complete', complete, admin)
    expect(completion.body.result.completion.values).toEqual(['November'])
  })

  test('notifies subscribers when a late tool renames a route companion', async () => {
    const end = Promise.withResolvers<void>()
    const app = new Elysia()
      .use(
        mcp({
          onNameCollision: 'suffix',
          core: {
            subscriptions: {
              promptsListChanged: true,
              provider: {
                async *subscribe() {
                  await end.promise
                }
              }
            }
          }
        })
      )
      .get('/reports', () => 'Report', {
        mcp: {
          name: 'reports',
          prompt: { render: () => 'Open the report.' }
        }
      })
    const diagnosticRegistry = getMcpRegistry(app, normalizeOptions({ allowedRoutes: [] }))
    expect(diagnosticRegistry.prompts.size).toBe(0)
    const response = await app.handle(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-protocol-version': '2026-07-28',
          'mcp-method': 'subscriptions/listen'
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'prompt-change',
          method: 'subscriptions/listen',
          params: {
            notifications: { promptsListChanged: true },
            _meta: {
              'io.modelcontextprotocol/protocolVersion': '2026-07-28',
              'io.modelcontextprotocol/clientInfo': { name: 'prompt-subscriber', version: '1.0.0' },
              'io.modelcontextprotocol/clientCapabilities': {}
            }
          }
        })
      })
    )
    try {
      expect(response.headers.get('content-type')).toContain('text/event-stream')
      app.mcpTool('reports', () => 'Explicit report')
      end.resolve()
      const stream = await response.text()
      expect(stream).toContain('notifications/subscriptions/acknowledged')
      expect(stream).toContain('notifications/prompts/list_changed')
      const updated = await modernRpc(app, 'prompts/list')
      expect(updated.body.result.prompts.map((prompt: { name: string }) => prompt.name)).toEqual([
        'reports_2'
      ])
    } finally {
      end.resolve()
      if (!response.bodyUsed) await response.body?.cancel()
    }
  })

  test('invalidates a replaced companion and scopes addition and removal signals', async () => {
    const app = new Elysia().use(mcp({ allowedRoutes: [] }))
    const scopes: unknown[] = []
    const stop = onRegistryChange(app, (kind, alternatives) => {
      if (kind === 'prompts') scopes.push(alternatives)
    })
    try {
      const initial = await modernRpc(app, 'prompts/list')
      expect(initial.body.result.prompts).toEqual([])
      app.mcpTool('reports', () => 'Tool', {
        authorization: { requiredScopes: ['reports:read'] },
        prompt: { render: () => 'Call reports.' }
      })
      app.mcpTool('reports', () => 'Tool')
      expect(scopes).toEqual([
        [{ requiredScopes: ['reports:read'] }],
        [{ requiredScopes: ['reports:read'] }]
      ])
      const removed = await modernRpc(app, 'prompts/list')
      expect(removed.body.result.prompts).toEqual([])
    } finally {
      stop()
    }
  })
})
