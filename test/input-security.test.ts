import { describe, expect, test } from 'bun:test'
import { Elysia, t } from 'elysia'
import { mcp, type TaskProvider } from '../src/index.js'
import { modernRpc, rpc } from './helpers.js'

const server = { name: 'input-security-test', version: '1.0.0' }

describe('tool input element budgets', () => {
  test('counts nested object members and array elements before route dispatch', async () => {
    let invocations = 0
    const app = new Elysia()
      .use(
        mcp({
          server,
          allowedRoutes: [],
          core: { maxToolInputElements: 5 },
          transport: { validateOrigin: false }
        })
      )
      .mcpTool(
        'batch',
        () => {
          invocations += 1
          return { accepted: true }
        },
        { inputSchema: { type: 'object', additionalProperties: true } }
      )

    const accepted = await modernRpc(app, 'tools/call', {
      name: 'batch',
      arguments: { batch: [{ id: 1 }, { id: 2 }] }
    })
    const rejected = await modernRpc(app, 'tools/call', {
      name: 'batch',
      arguments: { batch: [{ id: 1 }, { id: 2 }, { id: 3 }] }
    })

    expect(accepted.body.result.structuredContent).toEqual({ accepted: true })
    expect(rejected.status).toBe(400)
    expect(rejected.body.error).toMatchObject({
      code: -32602,
      data: { maxToolInputElements: 5 }
    })
    expect(invocations).toBe(1)
  })

  test('enforces the budget before Elysia route validation, hooks, and handlers', async () => {
    let guards = 0
    let handlers = 0
    const app = new Elysia()
      .use(
        mcp({
          server,
          core: { maxToolInputElements: 6 },
          transport: { validateOrigin: false }
        })
      )
      .post(
        '/batch',
        ({ body }) => {
          handlers += 1
          return { accepted: body.items.length }
        },
        {
          body: t.Object({ items: t.Array(t.Object({ id: t.Number() })) }),
          beforeHandle: () => {
            guards += 1
          },
          detail: { operationId: 'route.batch' }
        }
      )

    const accepted = await modernRpc(app, 'tools/call', {
      name: 'route.batch',
      arguments: { body: { items: [{ id: 1 }, { id: 2 }] } }
    })
    const rejected = await modernRpc(app, 'tools/call', {
      name: 'route.batch',
      arguments: { body: { items: [{ id: 1 }, { id: 2 }, { id: 3 }] } }
    })

    expect(accepted.body.result.structuredContent).toEqual({ accepted: 2 })
    expect(rejected.body.error).toMatchObject({
      code: -32602,
      data: { maxToolInputElements: 6 }
    })
    expect(guards).toBe(1)
    expect(handlers).toBe(1)
  })

  test('rejects oversized task inputs before creating or invoking a task', async () => {
    let creates = 0
    let invocations = 0
    const provider = {
      async create() {
        creates += 1
        throw new Error('provider must not run')
      }
    } as unknown as TaskProvider
    const app = new Elysia()
      .use(
        mcp({
          server,
          allowedRoutes: [],
          core: { maxToolInputElements: 1 },
          transport: { validateOrigin: false },
          extensions: { tasks: { provider } }
        })
      )
      .mcpTool(
        'task',
        () => {
          invocations += 1
          return { accepted: true }
        },
        { taskExecution: 'required' }
      )

    const rejected = await modernRpc(app, 'tools/call', {
      name: 'task',
      arguments: { first: true, second: true }
    })

    expect(rejected.body.error.code).toBe(-32602)
    expect(creates).toBe(0)
    expect(invocations).toBe(0)
  })

  test('requires a positive safe integer and leaves the budget unlimited when omitted', async () => {
    for (const value of [
      0,
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1
    ]) {
      expect(() => mcp({ server, core: { maxToolInputElements: value } })).toThrow(
        'Core maxToolInputElements must be a positive safe integer'
      )
    }

    const app = new Elysia()
      .use(mcp({ server, allowedRoutes: [], transport: { validateOrigin: false } }))
      .mcpTool('unlimited', () => ({ accepted: true }), {
        inputSchema: { type: 'object', additionalProperties: true }
      })
    const result = await modernRpc(app, 'tools/call', {
      name: 'unlimited',
      arguments: { values: Array.from({ length: 1_000 }, (_, index) => ({ index })) }
    })
    expect(result.body.result.structuredContent).toEqual({ accepted: true })
  })
})

describe('origin policy', () => {
  test('accepts exact origins and explicit non-HTTP scheme wildcards', async () => {
    const app = new Elysia().use(
      mcp({
        server,
        allowedRoutes: [],
        transport: {
          allowedOrigins: ['https://trusted.example', 'chrome-extension://*']
        }
      })
    )

    const exact = await rpc(app, 'tools/list', {}, { origin: 'https://trusted.example' })
    const extension = await rpc(app, 'tools/list', {}, { origin: 'chrome-extension://abc123' })
    const denied = await rpc(app, 'tools/list', {}, { origin: 'moz-extension://abc123' })

    expect(exact.status).toBe(200)
    expect(extension.status).toBe(200)
    expect(denied.status).toBe(403)
  })

  test('rejects malformed request origins and isolates wildcard configuration per app', async () => {
    const wildcardApp = new Elysia().use(
      mcp({
        server,
        allowedRoutes: [],
        transport: { allowedOrigins: ['chrome-extension://*'] }
      })
    )
    const exactApp = new Elysia().use(
      mcp({
        server,
        allowedRoutes: [],
        transport: { allowedOrigins: ['https://trusted.example'] }
      })
    )

    const malformed = await rpc(
      wildcardApp,
      'tools/list',
      {},
      { origin: 'chrome-extension://abc123/path' }
    )
    const wildcardAccepted = await rpc(
      wildcardApp,
      'tools/list',
      {},
      { origin: 'chrome-extension://abc123' }
    )
    const isolated = await rpc(exactApp, 'tools/list', {}, { origin: 'chrome-extension://abc123' })

    expect(malformed.status).toBe(403)
    expect(wildcardAccepted.status).toBe(200)
    expect(isolated.status).toBe(403)
  })

  test('rejects global, HTTP, malformed, credentialed, and opaque origin entries', () => {
    for (const origin of [
      '*',
      'http://*',
      'https://*',
      'https://trusted.example/path',
      'https://user@trusted.example',
      'chrome-extension://id whitespace',
      'chrome-extension://id:99999',
      'chrome-extension://id/path',
      'data:text/plain,hello',
      'null'
    ]) {
      expect(() => mcp({ server, transport: { allowedOrigins: [origin] } })).toThrow()
    }
  })
})
