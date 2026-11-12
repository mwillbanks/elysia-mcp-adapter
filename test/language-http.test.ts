import { describe, expect, spyOn, test } from 'bun:test'
import { Elysia, t } from 'elysia'
import {
  createMcpSubscriptionPublisher,
  getMcpInvocationContext,
  type McpLanguageOptions,
  mcp
} from '../src/index.js'
import type { DetailedTask, TaskProvider } from '../src/extensions/tasks/index.js'
import { McpProtocolError } from '../src/transport/protocol-error.js'
import { modernRpc, request, rpc } from './helpers.js'

const acceptKey = 'io.modelcontextprotocol/acceptLanguage'
const contentKey = 'io.modelcontextprotocol/contentLanguage'
const serverInfo = 'io.modelcontextprotocol/serverInfo'
const clientCapabilities = 'io.modelcontextprotocol/clientCapabilities'
const language: McpLanguageOptions = {
  supportedLanguages: ['en', 'fr'],
  defaultLanguage: 'en',
  localize({ language, original }) {
    return language === 'fr' ? 'FR ' + original : original
  }
}

function prefer(value: string): Record<string, unknown> {
  return { _meta: { [acceptKey]: value } }
}

describe('MCP request language over HTTP', () => {
  test('mirrors localized discovery and keeps opt-in request-scoped', async () => {
    const app = new Elysia()
      .use(
        mcp({
          allowedRoutes: [],
          core: { language },
          server: { name: 'server-id', title: 'Server', description: 'Guide' }
        })
      )
      .mcpTool('item-id', () => 'ok', { title: 'Display label', description: 'Help' })

    const localized = await modernRpc(app, 'server/discover', prefer('fr'), {
      'accept-language': 'fr'
    })
    expect(localized.headers.get('content-language')).toBe('fr')
    expect(localized.headers.get('vary')).toContain('Accept-Language')
    expect(localized.body.result._meta).toMatchObject({
      [serverInfo]: { name: 'server-id', title: 'FR Server', description: 'FR Guide' },
      [contentKey]: 'fr'
    })
    const list = await modernRpc(app, 'tools/list', prefer('fr'), { 'accept-language': 'fr' })
    expect(list.body.result.tools).toMatchObject([
      { name: 'item-id', title: 'FR Display label', description: 'FR Help' }
    ])

    const noPreferences: Record<string, string>[] = [{}, { 'accept-language': 'fr' }]
    for (const headers of noPreferences) {
      const next = await modernRpc(app, 'tools/list', {}, headers)
      expect(next.headers.get('content-language')).toBeNull()
      expect(next.headers.get('vary')).toContain('Accept-Language')
      expect(next.body.result.tools).toMatchObject([{ name: 'item-id', title: 'Display label' }])
    }
    const disabled = new Elysia().use(mcp({ allowedRoutes: [] }))
    const ignored = await modernRpc(disabled, 'tools/list', prefer('fr'), {
      'accept-language': 'en'
    })
    expect(ignored.status).toBe(200)
    expect(ignored.headers.get('vary')).toBeNull()
  })

  test('rejects exact mirror mismatches before handler invocation', async () => {
    let invoked = 0
    const app = new Elysia()
      .use(mcp({ allowedRoutes: [], core: { language } }))
      .mcpTool('side-effect', () => {
        invoked++
        return 'ok'
      })
    const params = { name: 'side-effect', arguments: {}, ...prefer('fr;q=1.000') }
    const mismatch = await modernRpc(app, 'tools/call', params, { 'accept-language': 'fr;q=1' })
    expect(mismatch.status).toBe(400)
    expect(mismatch.body.error).toMatchObject({ code: -32020 })
    expect(invoked).toBe(0)

    const batch = await request(
      app,
      'POST',
      { 'mcp-protocol-version': '2025-11-25', 'accept-language': 'fr;q=1' },
      JSON.stringify([
        { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'side-effect' } },
        { jsonrpc: '2.0', id: 2, method: 'tools/call', params }
      ])
    )
    expect(batch.status).toBe(400)
    expect(await batch.json()).toMatchObject({ id: 2, error: { code: -32020 } })
    expect(invoked).toBe(0)
  })

  test('localizes legacy batches and mirrors their agreed language', async () => {
    const app = new Elysia().use(
      mcp({ allowedRoutes: [], core: { language }, server: { title: 'Server' } })
    )
    const legacy = await rpc(app, 'initialize', prefer('fr'), { 'accept-language': 'fr' })
    expect(legacy.body.result).toMatchObject({
      protocolVersion: '2025-11-25',
      serverInfo: { title: 'FR Server' },
      _meta: { [contentKey]: 'fr' }
    })
    const batch = await request(
      app,
      'POST',
      { 'mcp-protocol-version': '2025-11-25', 'accept-language': 'fr' },
      JSON.stringify([
        { jsonrpc: '2.0', id: 3, method: 'initialize', params: prefer('fr') },
        { jsonrpc: '2.0', id: 4, method: 'ping' },
        { jsonrpc: '2.0', id: 7, method: 'initialize', params: prefer('fr') }
      ])
    )
    expect(batch.status).toBe(200)
    expect(batch.headers.get('content-language')).toBe('fr')
    expect(batch.headers.get('vary')).toContain('Accept-Language')
    expect(batch.headers.get('cache-control')).toBeNull()
    expect(await batch.json()).toMatchObject([
      { id: 3, result: { serverInfo: { title: 'FR Server' }, _meta: { [contentKey]: 'fr' } } },
      { id: 4, result: {} },
      { id: 7, result: { serverInfo: { title: 'FR Server' }, _meta: { [contentKey]: 'fr' } } }
    ])
  })

  test('keeps differing batch languages on individual items and a stripped batch private', async () => {
    const app = new Elysia().use(
      mcp({ allowedRoutes: [], core: { language }, server: { title: 'Server' } })
    )
    const batch = await request(
      app,
      'POST',
      { 'mcp-protocol-version': '2025-11-25' },
      JSON.stringify([
        { jsonrpc: '2.0', id: 5, method: 'initialize', params: prefer('fr') },
        { jsonrpc: '2.0', id: 6, method: 'initialize', params: prefer('en') }
      ])
    )
    expect(batch.status).toBe(200)
    expect(batch.headers.get('content-language')).toBeNull()
    expect(batch.headers.get('vary')).toContain('Accept-Language')
    expect(batch.headers.get('cache-control')).toContain('private')
    expect(await batch.json()).toMatchObject([
      { id: 5, result: { serverInfo: { title: 'FR Server' }, _meta: { [contentKey]: 'fr' } } },
      { id: 6, result: { serverInfo: { title: 'Server' }, _meta: { [contentKey]: 'en' } } }
    ])
  })

  test('keeps a stripped mirror private while preserving freshness and explicit route language', async () => {
    let hookCalls = 0
    const app = new Elysia()
      .use(
        mcp({
          core: { language, cache: { default: { cacheScope: 'public', ttlMs: 1000 } } }
        })
      )
      .get(
        '/edition',
        ({ query, request }) => ({
          chosen: query.language ?? getMcpInvocationContext(request)?.contentLanguage ?? 'none',
          forwarded: request.headers.has('accept-language')
        }),
        {
          query: t.Object({ language: t.Optional(t.String()) }),
          beforeHandle() {
            hookCalls++
          },
          mcp: { name: 'edition', title: 'Edition' }
        }
      )
    const cache = await modernRpc(app, 'tools/list', prefer('fr'))
    expect(cache.body.result).toMatchObject({ cacheScope: 'private', ttlMs: 1000 })
    expect(cache.headers.get('cache-control')).toContain('private')
    expect(cache.headers.get('content-language')).toBe('fr')
    const mirrored = await modernRpc(app, 'tools/list', prefer('fr'), { 'accept-language': 'fr' })
    expect(mirrored.body.result).toMatchObject({ cacheScope: 'public', ttlMs: 1000 })
    const omitted = await modernRpc(app, 'tools/list')
    expect(omitted.headers.get('vary')).toContain('Accept-Language')
    expect(omitted.headers.get('content-language')).toBeNull()
    expect(omitted.body.result).toMatchObject({ cacheScope: 'public', ttlMs: 1000 })
    const invoke = { name: 'edition', ...prefer('fr') }
    const fallback = await modernRpc(
      app,
      'tools/call',
      { ...invoke, arguments: {} },
      { 'accept-language': 'fr' }
    )
    const explicit = await modernRpc(
      app,
      'tools/call',
      {
        ...invoke,
        arguments: { query: { language: 'ga' } }
      },
      { 'accept-language': 'fr' }
    )
    expect(fallback.body.result.structuredContent).toMatchObject({ chosen: 'fr', forwarded: false })
    expect(explicit.body.result.structuredContent).toMatchObject({ chosen: 'ga', forwarded: false })
    expect(hookCalls).toBe(2)
  })

  test('mirrors an application error data language and preserves its developer message', async () => {
    const app = new Elysia()
      .use(mcp({ allowedRoutes: [], core: { language } }))
      .mcpTool('denied', () => {
        throw new McpProtocolError(-32000, 'Stable developer message', 400, {
          display: 'Erreur',
          _meta: { [contentKey]: 'fr' }
        })
      })
    const result = await modernRpc(
      app,
      'tools/call',
      { name: 'denied', arguments: {}, ...prefer('fr') },
      { 'accept-language': 'fr' }
    )
    expect(result.status).toBe(400)
    expect(result.headers.get('content-language')).toBe('fr')
    expect(result.body.error).toMatchObject({
      code: -32000,
      message: 'Stable developer message',
      data: { display: 'Erreur', _meta: { [contentKey]: 'fr' } }
    })
  })

  test('mirrors host-reported JSON result and error language without a request preference', async () => {
    const hostLanguage = 'fr-CA, en'
    const meta = { [contentKey]: hostLanguage }
    for (const enabled of [true, false]) {
      const app = new Elysia()
        .use(mcp({ allowedRoutes: [], core: enabled ? { language } : undefined }))
        .mcpTool('edition', () => ({
          content: [{ type: 'text', text: 'Canadian edition' }],
          _meta: meta
        }))
        .mcpTool('rejected', () => {
          throw new McpProtocolError(-32000, 'Stable developer message', 400, { _meta: meta })
        })
      const result = await modernRpc(app, 'tools/call', { name: 'edition' })
      const error = await modernRpc(app, 'tools/call', { name: 'rejected' })
      expect(result.body.result._meta[contentKey]).toBe(hostLanguage)
      expect(error.body.error).toMatchObject({
        message: 'Stable developer message',
        data: { _meta: meta }
      })
      expect(result.headers.get('Content-Language')).toBe(enabled ? hostLanguage : null)
      expect(error.headers.get('Content-Language')).toBe(enabled ? hostLanguage : null)
    }
  })

  test('localizes validated task input across create, poll and both notification modes', async () => {
    const task: DetailedTask = {
      taskId: 'task-approval',
      status: 'input_required',
      createdAt: '2026-07-28T12:00:00.000Z',
      lastUpdatedAt: '2026-07-28T12:00:00.000Z',
      ttlMs: null,
      inputRequests: {
        contact: {
          method: 'elicitation/create',
          params: {
            message: 'Contact',
            requestedSchema: {
              type: 'object',
              properties: { email: { type: 'string', title: 'Email', description: 'Address' } },
              required: ['email']
            }
          }
        }
      }
    }
    const provider: TaskProvider = {
      create: async () => task,
      get: async () => task,
      requestInput: async () => false,
      update: async () => false,
      cancel: async () => false,
      async listen(_ids, listener) {
        await listener(task)
        return { close() {} }
      }
    }
    const app = new Elysia()
      .use(
        mcp({
          allowedRoutes: [],
          extensions: { tasks: { provider } },
          core: {
            language,
            subscriptions: {
              provider: createMcpSubscriptionPublisher().provider,
              toolsListChanged: true
            }
          }
        })
      )
      .mcpTool('pending', () => 'unused', { taskExecution: 'required' })
      .mcpTool(
        'lookalike',
        () => ({
          ...task,
          resultType: 'task',
          content: [{ type: 'text', text: 'Ordinary tool output' }]
        }),
        { taskExecution: 'synchronous' }
      )
    const _meta = {
      [acceptKey]: 'fr',
      [clientCapabilities]: {
        elicitation: { form: {} },
        extensions: { 'io.modelcontextprotocol/tasks': {} }
      }
    }
    const expected = {
      taskId: task.taskId,
      status: 'input_required',
      inputRequests: {
        contact: {
          method: 'elicitation/create',
          params: {
            message: 'FR Contact',
            requestedSchema: {
              properties: {
                email: { type: 'string', title: 'FR Email', description: 'FR Address' }
              },
              required: ['email']
            }
          }
        }
      },
      _meta: { [contentKey]: 'fr' }
    }

    const headers = { 'accept-language': 'fr' }
    const created = await modernRpc(app, 'tools/call', { name: 'pending', _meta }, headers)
    expect(created.body.result).toMatchObject({ ...expected, resultType: 'task' })
    expect(created.headers.get('Content-Language')).toBe('fr')
    const polled = await modernRpc(app, 'tasks/get', { taskId: task.taskId, _meta }, headers)
    expect(polled.body.result).toMatchObject({ ...expected, resultType: 'complete' })
    expect(polled.headers.get('Content-Language')).toBe('fr')
    const lookalike = await modernRpc(app, 'tools/call', { name: 'lookalike', _meta }, headers)
    expect(lookalike.body.result.content).toEqual([{ type: 'text', text: 'Ordinary tool output' }])
    expect(lookalike.body.result.inputRequests).toEqual(task.inputRequests)
    expect(lookalike.headers.get('Content-Language')).toBeNull()

    const timer = 1 as unknown as ReturnType<typeof setInterval>
    const heartbeat = spyOn(globalThis, 'setInterval').mockReturnValue(timer)
    const clearHeartbeat = spyOn(globalThis, 'clearInterval').mockImplementation(() => {})
    try {
      for (const mixed of [false, true]) {
        const response = await request(
          app,
          'POST',
          {
            ...headers,
            'mcp-protocol-version': '2026-07-28',
            'mcp-method': 'subscriptions/listen',
            accept: 'application/json, text/event-stream'
          },
          JSON.stringify({
            jsonrpc: '2.0',
            id: 'task-stream',
            method: 'subscriptions/listen',
            params: {
              notifications: { taskIds: [task.taskId], ...(mixed && { toolsListChanged: true }) },
              _meta: { ..._meta, 'io.modelcontextprotocol/protocolVersion': '2026-07-28' }
            }
          })
        )
        expect(response.headers.get('content-type')).toContain('text/event-stream')
        expect(response.headers.get('Content-Language')).toBeNull()
        const reader = response.body!.getReader()
        const decoder = new TextDecoder()
        try {
          expect(decoder.decode((await reader.read()).value)).toContain(
            'notifications/subscriptions/acknowledged'
          )
          const frame = decoder.decode((await reader.read()).value)
          const message = JSON.parse(
            frame
              .split('\n')
              .find((line) => line.startsWith('data: '))!
              .slice(6)
          )
          expect(message).toMatchObject({
            method: 'notifications/tasks',
            params: {
              ...expected,
              _meta: { ...expected._meta, 'io.modelcontextprotocol/subscriptionId': 'task-stream' }
            }
          })
        } finally {
          await reader.cancel()
        }
      }
      expect(heartbeat).toHaveBeenCalledTimes(1)
      expect(clearHeartbeat).toHaveBeenCalledTimes(1)
    } finally {
      heartbeat.mockRestore()
      clearHeartbeat.mockRestore()
    }
    expect(task.inputRequests.contact?.params?.message).toBe('Contact')
  })

  test('uses message metadata for progress and the terminal input-required result on SSE', async () => {
    const app = new Elysia()
      .use(mcp({ allowedRoutes: [], core: { language } }))
      .mcpTool('ask', (_input, context) => {
        context.notify.progress(1, { message: 'Loading' })
        return {
          resultType: 'input_required',
          inputRequests: {
            contact: {
              method: 'elicitation/create',
              params: {
                mode: 'form',
                message: 'Contact',
                requestedSchema: {
                  type: 'object',
                  properties: { email: { type: 'string', title: 'Email', description: 'Address' } }
                }
              }
            }
          }
        } as const
      })
    const response = await request(
      app,
      'POST',
      {
        'mcp-protocol-version': '2026-07-28',
        'mcp-method': 'tools/call',
        'mcp-name': 'ask',
        accept: 'application/json, text/event-stream'
      },
      JSON.stringify({
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: {
          name: 'ask',
          arguments: {},
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            [clientCapabilities]: { elicitation: { form: {} } },
            [acceptKey]: 'fr',
            progressToken: 'progress-id'
          }
        }
      })
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    expect(response.headers.get('content-language')).toBeNull()
    expect(response.headers.get('vary')).toContain('Accept-Language')
    expect(response.headers.get('cache-control')).toContain('private')
    const messages = (await response.text())
      .split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => JSON.parse(line.slice('data: '.length)))
    expect(messages).toMatchObject([
      {
        method: 'notifications/progress',
        params: {
          progressToken: 'progress-id',
          message: 'FR Loading',
          _meta: { [contentKey]: 'fr' }
        }
      },
      {
        id: 5,
        result: {
          resultType: 'input_required',
          inputRequests: {
            contact: {
              method: 'elicitation/create',
              params: {
                message: 'FR Contact',
                requestedSchema: {
                  properties: {
                    email: { title: 'FR Email', description: 'FR Address' }
                  }
                }
              }
            }
          },
          _meta: { [contentKey]: 'fr' }
        }
      }
    ])
  })
})
