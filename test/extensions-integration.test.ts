import { describe, expect, test } from 'bun:test'
import { Elysia, t } from 'elysia'
import {
  type DetailedTask,
  getMcpTaskContext,
  MCP_APPS_RESOURCE_MIME_TYPE,
  type McpServerNotification,
  mcp,
  type TaskDurableCreateRequest,
  type TaskExecutionScheduler,
  type TaskInputResponses,
  type TaskProvider,
  type TaskProviderContext
} from '../src/index.js'
import { modernRpc, rpc } from './helpers.js'

const TASKS_CAPABILITY = {
  extensions: {
    'io.modelcontextprotocol/tasks': {}
  }
}

describe('modern MCP protocol', () => {
  test('discovers supported versions and preserves legacy initialization', async () => {
    const app = new Elysia().use(mcp())
    const modern = await modernRpc(app, 'server/discover')
    expect(modern.status).toBe(200)
    expect(modern.body.result).toMatchObject({
      cacheScope: 'private',
      resultType: 'complete',
      supportedVersions: ['2026-07-28', '2025-11-25'],
      ttlMs: 0
    })

    const legacy = await rpc(app, 'initialize')
    expect(legacy.body.result.protocolVersion).toBe('2025-11-25')
  })

  test('enforces modern header routing and HTTP method status', async () => {
    const app = new Elysia().use(mcp())
    const mismatch = await modernRpc(app, 'ping', {}, { 'mcp-method': 'tools/list' })
    expect(mismatch.status).toBe(400)
    expect(mismatch.body.error.code).toBe(-32020)

    const missing = await modernRpc(app, 'unknown/method')
    expect(missing.status).toBe(404)
    expect(missing.body.error.code).toBe(-32601)
  })

  test('validates modern notifications and unsupported protocol headers', async () => {
    const app = new Elysia().use(mcp())
    const invalidNotification = await app.handle(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-protocol-version': '2026-07-28',
          'mcp-method': 'notifications/initialized'
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'notifications/initialized',
          params: {}
        })
      })
    )
    expect(invalidNotification.status).toBe(400)
    expect((await invalidNotification.json()) as any).toMatchObject({ error: { code: -32020 } })

    const unsupported = await app.handle(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'mcp-protocol-version': '2099-01-01'
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })
      })
    )
    expect(unsupported.status).toBe(400)
    expect((await unsupported.json()) as any).toMatchObject({ error: { code: -32022 } })
  })

  test('rejects modern batches without changing legacy batches', async () => {
    const app = new Elysia().use(mcp())
    const defaultModern = await app.handle(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify([
          { jsonrpc: '2.0', id: 1, method: 'ping' },
          { jsonrpc: '2.0', id: 2, method: 'ping' }
        ])
      })
    )
    const defaultModernBody = (await defaultModern.json()) as any
    expect(defaultModern.status).toBe(400)
    expect(Array.isArray(defaultModernBody)).toBe(false)
    expect(defaultModernBody).not.toHaveProperty('id')
    expect(defaultModernBody.error.code).toBe(-32600)

    const modern = await app.handle(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'mcp-protocol-version': '2026-07-28'
        },
        body: JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'ping' }])
      })
    )
    expect(modern.status).toBe(400)

    const legacy = await app.handle(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'mcp-protocol-version': '2025-11-25'
        },
        body: JSON.stringify([
          { jsonrpc: '2.0', id: 1, method: 'ping' },
          { jsonrpc: '2.0', id: 'legacy-42', method: 'unknown/method' }
        ])
      })
    )
    expect(legacy.status).toBe(200)
    const legacyBody = (await legacy.json()) as any[]
    expect(legacyBody.map((response) => response.id)).toEqual([1, 'legacy-42'])
    expect(legacyBody[1].error.code).toBe(-32601)

    const legacyKnownError = await app.handle(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'mcp-protocol-version': '2025-11-25'
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 'legacy-42', method: 'unknown/method' })
      })
    )
    const legacyKnownErrorBody = (await legacyKnownError.json()) as any
    expect(legacyKnownErrorBody.id).toBe('legacy-42')
    expect(legacyKnownErrorBody.error.code).toBe(-32601)

    const legacyOnly = new Elysia().use(
      mcp({ transport: { protocolVersions: ['2025-11-25'], protocolVersion: '2025-11-25' } })
    )
    const legacyOnlyBatch = await legacyOnly.handle(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify([
          { jsonrpc: '2.0', id: 1, method: 'ping' },
          { jsonrpc: '2.0', id: 2, method: 'ping' }
        ])
      })
    )
    expect(legacyOnlyBatch.status).toBe(200)
    expect(((await legacyOnlyBatch.json()) as any[]).map((response) => response.id)).toEqual([1, 2])
  })

  test('selects auxiliary HTTP methods by protocol era', async () => {
    const app = new Elysia().use(
      mcp({ transport: { enableGetSse: true, enableDeleteSession: true } })
    )
    for (const method of ['GET', 'DELETE']) {
      const defaultModern = await app.handle(new Request('http://localhost/mcp', { method }))
      const defaultModernBody = (await defaultModern.json()) as any
      expect(defaultModern.status).toBe(405)
      expect(defaultModernBody).not.toHaveProperty('id')
      expect(defaultModernBody.error.code).toBe(-32600)
    }

    const legacyGet = await app.handle(
      new Request('http://localhost/mcp', {
        method: 'GET',
        headers: { 'mcp-protocol-version': '2025-11-25' }
      })
    )
    expect(legacyGet.status).toBe(200)
    expect(legacyGet.headers.get('content-type')).toBe('text/event-stream')

    const legacyDelete = await app.handle(
      new Request('http://localhost/mcp', {
        method: 'DELETE',
        headers: { 'mcp-protocol-version': '2025-11-25' }
      })
    )
    expect(legacyDelete.status).toBe(202)

    const legacyOnly = new Elysia().use(
      mcp({
        transport: {
          protocolVersions: ['2025-11-25'],
          protocolVersion: '2025-11-25',
          enableGetSse: true,
          enableDeleteSession: true
        }
      })
    )
    expect((await legacyOnly.handle(new Request('http://localhost/mcp'))).status).toBe(200)
    expect(
      (await legacyOnly.handle(new Request('http://localhost/mcp', { method: 'DELETE' }))).status
    ).toBe(202)
  })
})

describe('integrated authorization', () => {
  const resource = 'https://api.example.com/mcp'
  const verifyAccessToken = async (token: string) => ({
    tokenType: 'access_token' as const,
    subject: token,
    issuer: 'https://auth.example.com',
    audience: resource,
    scopes: token === 'admin' ? ['mcp', 'admin'] : ['mcp'],
    expiresAt: Math.floor(Date.now() / 1000) + 60
  })

  test('publishes endpoint metadata and gates before JSON-RPC parsing', async () => {
    const app = new Elysia().use(
      mcp({
        extensions: {
          auth: {
            resource,
            authorizationServers: ['https://auth.example.com'],
            scopes: ['mcp'],
            verifyAccessToken
          }
        }
      })
    )
    const metadata = await app.handle(
      new Request('http://localhost/.well-known/oauth-protected-resource/mcp')
    )
    expect(metadata.status).toBe(200)
    expect((await metadata.json()).resource).toBe(resource)

    const missing = await app.handle(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{'
      })
    )
    expect(missing.status).toBe(401)
    expect(missing.headers.get('www-authenticate')).toContain('resource_metadata=')
  })

  test('filters unauthorized primitives and enforces operation scopes again', async () => {
    const app = new Elysia()
      .use(
        mcp({
          allowedRoutes: [],
          extensions: {
            auth: {
              resource,
              authorizationServers: ['https://auth.example.com'],
              scopes: ['mcp'],
              verifyAccessToken
            }
          }
        })
      )
      .mcpTool('public-tool', () => 'ok')
      .mcpTool('admin-tool', () => 'secret', {
        authorization: { requiredScopes: ['admin'] }
      })

    const listed = await modernRpc(app, 'tools/list', {}, { authorization: 'Bearer user' })
    expect(listed.body.result.tools.map((tool: { name: string }) => tool.name)).toEqual([
      'public-tool'
    ])

    const denied = await modernRpc(
      app,
      'tools/call',
      { name: 'admin-tool' },
      { authorization: 'Bearer user' }
    )
    expect(denied.status).toBe(403)
    expect(denied.headers.get('www-authenticate')).toContain('insufficient_scope')
  })

  test('protects opted-in legacy auxiliary methods', async () => {
    const app = new Elysia().use(
      mcp({
        transport: { enableGetSse: true, enableDeleteSession: true },
        extensions: {
          auth: {
            resource,
            authorizationServers: ['https://auth.example.com'],
            scopes: ['mcp'],
            verifyAccessToken
          }
        }
      })
    )

    for (const method of ['GET', 'DELETE']) {
      const missing = await app.handle(new Request('http://localhost/mcp', { method }))
      expect(missing.status).toBe(401)
    }
  })

  test('exposes only normalized authorization while preserving the route guard header', async () => {
    let explicitSawRawToken = false
    let routeSawAuthorization = false
    const app = new Elysia()
      .use(
        mcp({
          extensions: {
            auth: {
              resource,
              authorizationServers: ['https://auth.example.com'],
              scopes: ['mcp'],
              verifyAccessToken
            }
          }
        })
      )
      .mcpTool('authorization.context', (_input, context) => {
        explicitSawRawToken = isRecord(context.authorization) && 'token' in context.authorization
        return { subject: context.authorization?.principal.subject }
      })
      .get('/guarded', () => ({ guarded: true }), {
        beforeHandle({ headers }) {
          routeSawAuthorization = headers.authorization === 'Bearer user'
        },
        detail: { operationId: 'guarded' }
      })

    await modernRpc(
      app,
      'tools/call',
      { name: 'authorization.context' },
      { authorization: 'Bearer user' }
    )
    await modernRpc(
      app,
      'tools/call',
      { name: 'guarded', arguments: {} },
      { authorization: 'Bearer user' }
    )
    expect(explicitSawRawToken).toBe(false)
    expect(routeSawAuthorization).toBe(true)
  })
})

describe('integrated Tasks', () => {
  test('honors synchronous and required tool policies', async () => {
    const disabled = new Elysia()
      .use(mcp({ allowedRoutes: [] }))
      .mcpTool('misconfigured-required', () => ({ mustNotRun: true }), {
        taskExecution: 'required'
      })
    const disabledResult = await modernRpc(disabled, 'tools/call', {
      name: 'misconfigured-required',
      _meta: {
        'io.modelcontextprotocol/clientCapabilities': TASKS_CAPABILITY
      }
    })
    expect(disabledResult.status).toBe(400)
    expect(disabledResult.body.error.code).toBe(-32021)

    const provider = new IntegrationTaskProvider()
    const app = new Elysia()
      .use(mcp({ allowedRoutes: [], extensions: { tasks: { provider } } }))
      .mcpTool('always-sync', () => ({ mode: 'sync' }), {
        taskExecution: 'synchronous'
      })
      .mcpTool('always-task', () => ({ mode: 'task' }), {
        taskExecution: 'required'
      })

    const synchronous = await modernRpc(app, 'tools/call', {
      name: 'always-sync',
      _meta: {
        'io.modelcontextprotocol/clientCapabilities': TASKS_CAPABILITY
      }
    })
    expect(synchronous.body.result.resultType).toBe('complete')

    const missing = await modernRpc(app, 'tools/call', { name: 'always-task' })
    expect(missing.status).toBe(400)
    expect(missing.body.error.code).toBe(-32021)

    const created = await modernRpc(app, 'tools/call', {
      name: 'always-task',
      _meta: {
        'io.modelcontextprotocol/clientCapabilities': TASKS_CAPABILITY
      }
    })
    expect(created.body.result.resultType).toBe('task')
  })

  test('selects optional tasks and preserves route lifecycle and task context', async () => {
    const provider = new IntegrationTaskProvider()
    let guarded = false
    let sawController = false
    const app = new Elysia().use(mcp({ extensions: { tasks: { provider } } })).get(
      '/work/:id',
      ({ params, request }) => {
        sawController = getMcpTaskContext(request) !== undefined
        return { id: params.id, guarded }
      },
      {
        params: t.Object({ id: t.String() }),
        beforeHandle() {
          guarded = true
        },
        mcp: {
          name: 'work',
          taskExecution: 'optional'
        }
      }
    )

    const synchronous = await modernRpc(app, 'tools/call', {
      name: 'work',
      arguments: { params: { id: 'sync' } }
    })
    expect(synchronous.body.result.structuredContent.id).toBe('sync')

    const created = await modernRpc(app, 'tools/call', {
      name: 'work',
      arguments: { params: { id: 'task' } },
      _meta: {
        'io.modelcontextprotocol/clientCapabilities': TASKS_CAPABILITY
      }
    })
    expect(created.body.result.resultType).toBe('task')
    await provider.execution
    expect(sawController).toBe(true)

    const polled = await modernRpc(app, 'tasks/get', {
      taskId: created.body.result.taskId,
      _meta: {
        'io.modelcontextprotocol/clientCapabilities': TASKS_CAPABILITY
      }
    })
    expect(polled.body.result.status).toBe('completed')
    expect(polled.body.result.result.structuredContent.guarded).toBe(true)
  })

  test('propagates provider cancellation signals into task execution', async () => {
    const provider = new IntegrationTaskProvider()
    provider.executionSignal = AbortSignal.abort()
    let contextAborted = false
    let requestAborted = false
    const app = new Elysia()
      .use(mcp({ allowedRoutes: [], extensions: { tasks: { provider } } }))
      .mcpTool(
        'cancel-aware',
        (_input, context) => {
          contextAborted = context.signal?.aborted === true
          requestAborted = context.request.signal.aborted
          return { cancelled: contextAborted && requestAborted }
        },
        { taskExecution: 'required' }
      )

    await modernRpc(app, 'tools/call', {
      name: 'cancel-aware',
      _meta: {
        'io.modelcontextprotocol/clientCapabilities': TASKS_CAPABILITY
      }
    })
    await provider.execution

    expect(contextAborted).toBe(true)
    expect(requestAborted).toBe(true)
  })

  test('requires per-request capability and rejects Tasks on legacy', async () => {
    const provider = new IntegrationTaskProvider()
    const app = new Elysia().use(mcp({ extensions: { tasks: { provider } } }))
    const modern = await modernRpc(app, 'tasks/get', { taskId: 'missing' })
    expect(modern.body.error.code).toBe(-32021)
    const legacy = await rpc(app, 'tasks/get', { taskId: 'missing' })
    expect(legacy.status).toBe(404)
    expect(legacy.body.error.code).toBe(-32601)
  })

  test('requires task IDs in modern routing headers', async () => {
    const app = new Elysia().use(
      mcp({ extensions: { tasks: { provider: new IntegrationTaskProvider() } } })
    )
    const response = await app.handle(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'mcp-protocol-version': '2026-07-28',
          'mcp-method': 'tasks/get'
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tasks/get',
          params: {
            taskId: 'task-1',
            _meta: {
              'io.modelcontextprotocol/protocolVersion': '2026-07-28',
              'io.modelcontextprotocol/clientInfo': { name: 'test-client', version: '1.0.0' },
              'io.modelcontextprotocol/clientCapabilities': TASKS_CAPABILITY
            }
          }
        })
      })
    )

    expect(response.status).toBe(400)
    expect(((await response.json()) as any).error.code).toBe(-32020)
  })

  test('acknowledges subscriptions before complete task snapshots and cleans up', async () => {
    const provider = new IntegrationTaskProvider()
    const now = new Date().toISOString()
    provider.tasks.set('observed', {
      taskId: 'observed',
      status: 'working',
      createdAt: now,
      lastUpdatedAt: now,
      ttlMs: 60_000
    })
    const app = new Elysia().use(mcp({ extensions: { tasks: { provider } } }))
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
          id: 7,
          method: 'subscriptions/listen',
          params: {
            notifications: { taskIds: ['observed'] },
            _meta: {
              'io.modelcontextprotocol/protocolVersion': '2026-07-28',
              'io.modelcontextprotocol/clientInfo': { name: 'test-client', version: '1.0.0' },
              'io.modelcontextprotocol/clientCapabilities': TASKS_CAPABILITY
            }
          }
        })
      })
    )
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    const reader = response.body?.getReader()
    if (!reader) throw new Error('Missing subscription body')
    const first = new TextDecoder().decode((await reader.read()).value)
    const second = new TextDecoder().decode((await reader.read()).value)
    expect(first).toContain('"notifications/subscriptions/acknowledged"')
    expect(first).toContain('"io.modelcontextprotocol/subscriptionId":7')
    expect(second).toContain('"notifications/tasks"')
    expect(second).toContain('"status":"working"')
    expect(second).not.toContain('"task":')
    await reader.cancel()
    expect(provider.subscriptionClosed).toBe(true)
  })

  test('acknowledges only provider-accepted task subscriptions', async () => {
    const provider = new IntegrationTaskProvider()
    provider.acceptedTaskIds = ['accepted']
    const now = new Date().toISOString()
    provider.tasks.set('accepted', {
      taskId: 'accepted',
      status: 'working',
      createdAt: now,
      lastUpdatedAt: now,
      ttlMs: 60_000
    })
    const app = new Elysia().use(mcp({ extensions: { tasks: { provider } } }))
    const response = await taskSubscriptionRequest(app, ['accepted', 'declined'])
    const reader = response.body?.getReader()
    if (!reader) throw new Error('Missing subscription body')
    const first = new TextDecoder().decode((await reader.read()).value)
    expect(first).toContain('"taskIds":["accepted"]')
    await reader.cancel()
  })

  test('closes task subscriptions when the incoming HTTP request aborts', async () => {
    const provider = new IntegrationTaskProvider()
    provider.tasks.set('observed', workingIntegrationTask('observed'))
    const app = new Elysia().use(mcp({ extensions: { tasks: { provider } } }))
    const incomingAbort = new AbortController()
    const response = await taskSubscriptionRequest(app, ['observed'], incomingAbort.signal)
    const reader = response.body?.getReader()
    if (!reader) throw new Error('Missing subscription body')
    expect(new TextDecoder().decode((await reader.read()).value)).toContain(
      'notifications/subscriptions/acknowledged'
    )
    incomingAbort.abort('HTTP client disconnected')
    await Bun.sleep(0)
    expect(provider.subscriptionClosed).toBe(true)
    expect(provider.subscriptionCloseCalls).toBe(1)
    let streamDone = false
    for (let count = 0; count < 3 && !streamDone; count += 1) {
      streamDone = (await reader.read()).done
    }
    expect(streamDone).toBe(true)

    const racingProvider = new IntegrationTaskProvider()
    let releaseListen: (() => void) | undefined
    const listenBarrier = new Promise<void>((resolve) => {
      releaseListen = resolve
    })
    const originalListen = racingProvider.listen.bind(racingProvider)
    Object.defineProperty(racingProvider, 'listen', {
      value: async (...args: Parameters<IntegrationTaskProvider['listen']>) => {
        await listenBarrier
        return originalListen(...args)
      }
    })
    const racingApp = new Elysia().use(mcp({ extensions: { tasks: { provider: racingProvider } } }))
    const setupAbort = new AbortController()
    const pendingResponse = taskSubscriptionRequest(racingApp, ['observed'], setupAbort.signal)
    setupAbort.abort('HTTP client disconnected during setup')
    releaseListen?.()
    const setupResponse = await pendingResponse
    expect(racingProvider.subscriptionClosed).toBe(true)
    expect(racingProvider.subscriptionCloseCalls).toBe(1)
    expect((await setupResponse.body?.getReader().read())?.done).toBe(true)

    const alreadyAbortedProvider = new IntegrationTaskProvider()
    const alreadyAborted = new AbortController()
    alreadyAborted.abort('HTTP client already disconnected')
    const alreadyAbortedResponse = await taskSubscriptionRequest(
      new Elysia().use(mcp({ extensions: { tasks: { provider: alreadyAbortedProvider } } })),
      ['observed'],
      alreadyAborted.signal
    )
    expect(alreadyAbortedProvider.subscriptionClosed).toBe(true)
    expect(alreadyAbortedProvider.subscriptionCloseCalls).toBe(1)
    expect((await alreadyAbortedResponse.body?.getReader().read())?.done).toBe(true)
  })

  test('cancels streams that receive notifications outside the accepted subset', async () => {
    const provider = new IntegrationTaskProvider()
    provider.acceptedTaskIds = ['accepted']
    const app = new Elysia().use(mcp({ extensions: { tasks: { provider } } }))
    const response = await taskSubscriptionRequest(app, ['accepted', 'declined'])
    const reader = response.body?.getReader()
    if (!reader) throw new Error('Missing subscription body')
    const first = new TextDecoder().decode((await reader.read()).value)
    expect(first).toContain('"taskIds":["accepted"]')

    provider.subscriptionListener?.({
      ...workingIntegrationTask('declined'),
      taskId: 'declined'
    })
    const closure =
      new TextDecoder().decode((await reader.read()).value) +
      new TextDecoder().decode((await reader.read()).value)
    expect(closure).toContain('notifications/cancelled')
    expect(closure).toContain('"requestId":7')
    expect(closure).toContain('"resultType":"complete"')
    expect(provider.subscriptionClosed).toBe(true)
  })

  test('contains provider cleanup failures after a subscription contract error', async () => {
    const provider = new IntegrationTaskProvider()
    provider.acceptedTaskIds = ['accepted']
    provider.rejectSubscriptionClose = true
    const app = new Elysia().use(mcp({ extensions: { tasks: { provider } } }))
    const response = await taskSubscriptionRequest(app, ['accepted', 'declined'])
    const reader = response.body?.getReader()
    if (!reader) throw new Error('Missing subscription body')
    await reader.read()

    provider.subscriptionListener?.(workingIntegrationTask('declined'))
    const closure =
      new TextDecoder().decode((await reader.read()).value) +
      new TextDecoder().decode((await reader.read()).value)
    expect(closure).toContain('notifications/cancelled')
    expect(closure).toContain('"resultType":"complete"')
  })

  test('completes subscriptions gracefully when the provider cannot listen', async () => {
    const provider = new IntegrationTaskProvider()
    Object.defineProperty(provider, 'listen', { value: undefined })
    const app = new Elysia().use(mcp({ extensions: { tasks: { provider } } }))
    const response = await taskSubscriptionRequest(app, ['unavailable'])
    const body = await response.text()

    expect(body).toContain('"notifications/subscriptions/acknowledged"')
    expect(body).toContain('"taskIds":[]')
    expect(body).toContain('"notifications/cancelled"')
    expect(body.indexOf('notifications/cancelled')).toBeLessThan(
      body.indexOf('"resultType":"complete"')
    )
    expect(body).toContain('"resultType":"complete"')
  })

  test('combines task and core subscription filters without mixing progress or logging', async () => {
    const provider = new IntegrationTaskProvider()
    const incomingAbort = new AbortController()
    let coreAborted = false
    provider.tasks.set('observed', workingIntegrationTask('observed'))
    const app = new Elysia().use(
      mcp({
        allowedRoutes: [],
        extensions: { tasks: { provider } },
        core: {
          subscriptions: {
            toolsListChanged: true,
            heartbeatMs: 1000,
            provider: {
              subscribe(_filter, context) {
                return (async function* () {
                  try {
                    yield { method: 'notifications/tools/list_changed' as const }
                    await new Promise<void>((resolve) => {
                      context.signal?.addEventListener('abort', () => resolve(), { once: true })
                    })
                  } finally {
                    coreAborted = context.signal?.aborted === true
                  }
                })()
              }
            }
          }
        }
      })
    )
    const response = await app.handle(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-protocol-version': '2026-07-28',
          'mcp-method': 'subscriptions/listen'
        },
        signal: incomingAbort.signal,
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 8,
          method: 'subscriptions/listen',
          params: {
            notifications: { taskIds: ['observed'], toolsListChanged: true },
            _meta: {
              'io.modelcontextprotocol/protocolVersion': '2026-07-28',
              'io.modelcontextprotocol/clientInfo': { name: 'test-client', version: '1.0.0' },
              'io.modelcontextprotocol/clientCapabilities': TASKS_CAPABILITY
            }
          }
        })
      })
    )
    const reader = response.body?.getReader()
    if (!reader) throw new Error('Missing mixed subscription body')
    const decoder = new TextDecoder()
    let stream = ''
    for (let count = 0; count < 4; count += 1) {
      const next = await reader.read()
      stream += decoder.decode(next.value, { stream: !next.done })
      if (
        stream.includes('notifications/subscriptions/acknowledged') &&
        stream.includes('notifications/tasks') &&
        stream.includes('notifications/tools/list_changed')
      ) {
        break
      }
    }
    expect(stream).toContain('"taskIds":["observed"]')
    expect(stream).toContain('"toolsListChanged":true')
    expect(stream).not.toContain('notifications/progress')
    expect(stream).not.toContain('notifications/message')
    incomingAbort.abort('HTTP client disconnected')
    await Bun.sleep(0)
    expect(coreAborted).toBe(true)
    expect(provider.subscriptionClosed).toBe(true)
    await reader.cancel()
  })

  test('cleans core subscriptions when mixed task setup fails', async () => {
    for (const invalidAcceptedSubset of [false, true]) {
      const provider = new IntegrationTaskProvider()
      let iteratorReturns = 0
      let failedTaskSetupSignal: AbortSignal | undefined
      if (invalidAcceptedSubset) {
        provider.acceptedTaskIds = ['unrequested']
        provider.rejectSubscriptionClose = true
      } else {
        Object.defineProperty(provider, 'listen', {
          value: async (
            _taskIds: string[],
            _listener: unknown,
            context: { signal?: AbortSignal }
          ) => {
            failedTaskSetupSignal = context.signal
            throw new Error('task listen failed')
          }
        })
      }
      const app = new Elysia().use(
        mcp({
          allowedRoutes: [],
          extensions: { tasks: { provider } },
          core: {
            subscriptions: {
              toolsListChanged: true,
              provider: {
                subscribe: () => {
                  const iterator: AsyncIterableIterator<McpServerNotification> = {
                    [Symbol.asyncIterator]() {
                      return this
                    },
                    next: async () => new Promise<IteratorResult<McpServerNotification>>(() => {}),
                    return: async () => {
                      iteratorReturns += 1
                      throw new Error('core cleanup failed')
                    }
                  }
                  return iterator
                }
              }
            }
          }
        })
      )
      const response = await mixedSubscriptionRequest(app, {
        taskIds: ['observed'],
        toolsListChanged: true
      })
      expect(response.status).toBe(200)
      const error = ((await response.json()) as any).error
      expect(error.code).toBe(-32603)
      expect(error.message).toBe(
        invalidAcceptedSubset
          ? 'Task provider accepted an unrequested subscription task'
          : 'task listen failed'
      )
      expect(iteratorReturns).toBe(1)
      expect(provider.subscriptionClosed).toBe(invalidAcceptedSubset)
      expect(provider.subscriptionCloseCalls).toBe(invalidAcceptedSubset ? 1 : 0)
      if (!invalidAcceptedSubset) expect(failedTaskSetupSignal?.aborted).toBe(true)
    }
  })

  test('binds provider operations to the verifier-derived principal key', async () => {
    const provider = new IntegrationTaskProvider()
    const resource = 'https://api.example.com/mcp'
    const app = new Elysia()
      .use(
        mcp({
          allowedRoutes: [],
          extensions: {
            tasks: { provider },
            auth: {
              resource,
              authorizationServers: ['https://auth.example.com'],
              verifyAccessToken: async (token) => ({
                tokenType: 'access_token' as const,
                subject: token,
                issuer: 'https://auth.example.com',
                audience: resource,
                scopes: [],
                expiresAt: Math.floor(Date.now() / 1000) + 60
              })
            }
          }
        })
      )
      .mcpTool('owned-task', () => ({ owner: true }), { taskExecution: 'required' })

    const created = await modernRpc(
      app,
      'tools/call',
      {
        name: 'owned-task',
        _meta: {
          'io.modelcontextprotocol/clientCapabilities': TASKS_CAPABILITY
        }
      },
      { authorization: 'Bearer alice' }
    )
    expect(created.body.result.taskId).toMatch(/^[0-9a-f-]{36}$/)

    const denied = await modernRpc(
      app,
      'tasks/get',
      {
        taskId: created.body.result.taskId,
        _meta: {
          'io.modelcontextprotocol/clientCapabilities': TASKS_CAPABILITY
        }
      },
      { authorization: 'Bearer bob' }
    )
    expect(denied.body.error.code).toBe(-32602)
  })

  test('uses collision-safe verifier-derived principal keys', async () => {
    const provider = new IntegrationTaskProvider()
    const resource = 'https://api.example.com/mcp'
    const app = new Elysia()
      .use(
        mcp({
          allowedRoutes: [],
          extensions: {
            tasks: { provider },
            auth: {
              resource,
              authorizationServers: ['https://auth.example.com'],
              verifyAccessToken: async (token) => ({
                tokenType: 'access_token' as const,
                subject: token === 'principal-a' ? 'x' : 'x\u0000y',
                clientId: token === 'principal-a' ? 'y\u0000z' : 'z',
                issuer: 'https://auth.example.com',
                audience: resource,
                scopes: [],
                expiresAt: Math.floor(Date.now() / 1000) + 60
              })
            }
          }
        })
      )
      .mcpTool('collision-safe-task', () => ({ ok: true }), { taskExecution: 'required' })

    const created = await modernRpc(
      app,
      'tools/call',
      {
        name: 'collision-safe-task',
        _meta: {
          'io.modelcontextprotocol/clientCapabilities': TASKS_CAPABILITY
        }
      },
      { authorization: 'Bearer principal-a' }
    )
    const denied = await modernRpc(
      app,
      'tasks/get',
      {
        taskId: created.body.result.taskId,
        _meta: {
          'io.modelcontextprotocol/clientCapabilities': TASKS_CAPABILITY
        }
      },
      { authorization: 'Bearer principal-b' }
    )

    expect(denied.body.error.code).toBe(-32602)
  })
})

describe('integrated Apps', () => {
  test('advertises the implemented Apps MIME type in modern discovery', async () => {
    const app = new Elysia().use(mcp({ allowedRoutes: [], extensions: { apps: {} } }))
    const discovery = await modernRpc(app, 'server/discover')
    expect(discovery.body.result.capabilities.extensions['io.modelcontextprotocol/ui']).toEqual({
      mimeTypes: [MCP_APPS_RESOURCE_MIME_TYPE]
    })
  })

  test('normalizes tool and resource metadata and preserves fallback content', async () => {
    const uri = 'ui://weather/index.html'
    const app = new Elysia()
      .use(mcp({ allowedRoutes: [], extensions: { apps: {} } }))
      .mcpTool(
        'weather.open',
        () => ({
          content: [{ type: 'text', text: 'Weather is 72 degrees.' }],
          structuredContent: { temperature: 72 }
        }),
        { app: { resourceUri: uri, visibility: ['model', 'app'] } }
      )
      .mcpResource(
        uri,
        () => ({
          contents: [
            {
              uri,
              mimeType: MCP_APPS_RESOURCE_MIME_TYPE,
              text: '<!doctype html><html><body>Weather</body></html>',
              _meta: {
                traceId: 'content-trace',
                ui: { prefersBorder: false }
              }
            }
          ]
        }),
        {
          mimeType: MCP_APPS_RESOURCE_MIME_TYPE,
          app: {
            csp: { connectDomains: ['https://api.example.com'] },
            prefersBorder: true
          }
        }
      )

    const tools = await modernRpc(app, 'tools/list')
    expect(tools.body.result.tools[0]._meta.ui.resourceUri).toBe(uri)
    expect(tools.body.result.tools[0]._meta['ui/resourceUri']).toBe(uri)

    const read = await modernRpc(app, 'resources/read', { uri })
    expect(read.body.result.contents[0]._meta.traceId).toBe('content-trace')
    expect(read.body.result.contents[0]._meta.ui.prefersBorder).toBe(false)
    expect(read.body.result.contents[0]._meta.ui.csp).toBeUndefined()

    const called = await modernRpc(app, 'tools/call', { name: 'weather.open' })
    expect(called.body.result.content[0].text).toContain('72')
  })
})

class IntegrationTaskProvider implements TaskProvider {
  readonly tasks = new Map<string, DetailedTask>()
  readonly owners = new Map<string, string | undefined>()
  execution: Promise<void> = Promise.resolve()
  executionSignal?: AbortSignal
  subscriptionClosed = false
  subscriptionCloseCalls = 0
  acceptedTaskIds?: readonly string[]
  subscriptionListener?: (task: DetailedTask) => void | Promise<void>
  rejectSubscriptionClose = false

  async create(
    _request: TaskDurableCreateRequest,
    context: TaskProviderContext,
    scheduler: TaskExecutionScheduler
  ) {
    const now = new Date().toISOString()
    const task = {
      taskId: crypto.randomUUID(),
      status: 'working' as const,
      createdAt: now,
      lastUpdatedAt: now,
      ttlMs: 60_000,
      pollIntervalMs: 10
    }
    this.tasks.set(task.taskId, task)
    this.owners.set(task.taskId, context.principalKey)
    this.execution = scheduler.invoke(this.executionSignal).then((result) => {
      this.tasks.set(task.taskId, {
        ...task,
        status: 'completed',
        lastUpdatedAt: new Date().toISOString(),
        result
      })
    })
    return task
  }

  async get(taskId: string, context?: TaskProviderContext) {
    const owner = this.owners.get(taskId)
    if (owner !== undefined && owner !== context?.principalKey) return undefined
    return this.tasks.get(taskId)
  }

  async update(_taskId: string, _responses: TaskInputResponses) {
    return true
  }

  async requestInput() {
    return true
  }

  async cancel(taskId: string) {
    const task = this.tasks.get(taskId)
    if (!task) return false
    this.tasks.set(taskId, { ...task, status: 'cancelled' })
    return true
  }

  listen(taskIds: readonly string[], listener: (task: DetailedTask) => void) {
    this.subscriptionListener = listener
    for (const taskId of taskIds) {
      const task = this.tasks.get(taskId)
      if (task) listener(task)
    }
    return {
      acceptedTaskIds: this.acceptedTaskIds,
      close: async () => {
        this.subscriptionClosed = true
        this.subscriptionCloseCalls += 1
        if (this.rejectSubscriptionClose) throw new Error('cleanup failed')
      }
    }
  }
}

function workingIntegrationTask(taskId: string): DetailedTask {
  const now = new Date().toISOString()
  return {
    taskId,
    status: 'working',
    createdAt: now,
    lastUpdatedAt: now,
    ttlMs: 60_000
  }
}

function taskSubscriptionRequest(app: Elysia, taskIds: readonly string[], signal?: AbortSignal) {
  return app.handle(
    new Request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2026-07-28',
        'mcp-method': 'subscriptions/listen'
      },
      signal,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 7,
        method: 'subscriptions/listen',
        params: {
          notifications: { taskIds },
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientInfo': { name: 'test-client', version: '1.0.0' },
            'io.modelcontextprotocol/clientCapabilities': TASKS_CAPABILITY
          }
        }
      })
    })
  )
}

function mixedSubscriptionRequest(app: Elysia, notifications: Record<string, unknown>) {
  return app.handle(
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
        id: 9,
        method: 'subscriptions/listen',
        params: {
          notifications,
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientInfo': { name: 'test-client', version: '1.0.0' },
            'io.modelcontextprotocol/clientCapabilities': TASKS_CAPABILITY
          }
        }
      })
    })
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
