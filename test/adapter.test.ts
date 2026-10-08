import { describe, expect, it } from 'bun:test'
import { Elysia, t } from 'elysia'
import { mcp } from '../src/index.js'
import { rpc } from './helpers.js'

const server = { name: 'test', version: '1.0.0' } as const

describe('tools', () => {
  it('lists route-backed tools using operationId', async () => {
    const app = new Elysia()
      .use(mcp({ server, transport: { validateOrigin: false } }))
      .get('/users/:id', ({ params }) => ({ id: params.id }), {
        params: t.Object({ id: t.String() }),
        response: t.Object({ id: t.String() }),
        detail: { operationId: 'users.get', summary: 'Get user' }
      })

    const { body } = await rpc(app, 'tools/list')

    expect(body.result.tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'users.get',
          inputSchema: expect.objectContaining({ type: 'object' })
        })
      ])
    )
  })

  it('derives conservative annotations from the HTTP method', async () => {
    const app = new Elysia()
      .use(mcp({ server, transport: { validateOrigin: false } }))
      .get('/read', () => ({ ok: true }), { detail: { operationId: 'read' } })
      .delete('/wipe/:id', () => ({ ok: true }), {
        params: t.Object({ id: t.String() }),
        detail: { operationId: 'wipe' }
      })

    const { body } = await rpc(app, 'tools/list')
    const byName = Object.fromEntries(body.result.tools.map((tool: any) => [tool.name, tool]))

    expect(byName.read.annotations).toEqual({ readOnlyHint: true, idempotentHint: true })
    expect(byName.wipe.annotations).toEqual({ readOnlyHint: false, destructiveHint: true })
  })

  it('invokes route-backed tools through app.handle', async () => {
    const app = new Elysia()
      .use(mcp({ server, transport: { validateOrigin: false } }))
      .get('/users/:id', ({ params, query }) => ({ id: params.id, include: query.include }), {
        params: t.Object({ id: t.String() }),
        query: t.Object({ include: t.Optional(t.String()) }),
        detail: { operationId: 'users.get' }
      })

    const { body } = await rpc(app, 'tools/call', {
      name: 'users.get',
      arguments: { params: { id: 'u_123' }, query: { include: 'teams' } }
    })

    expect(body.result.structuredContent).toEqual({ id: 'u_123', include: 'teams' })
    expect(body.result.content[0].text).toContain('u_123')
  })

  it('preserves Elysia validation and marshals HTTP errors as tool errors', async () => {
    const app = new Elysia()
      .use(mcp({ server, transport: { validateOrigin: false } }))
      .get(
        '/things/:id',
        ({ params, status }) =>
          params.id === 'missing' ? status(404, { error: 'not found' }) : { id: params.id },
        {
          params: t.Object({ id: t.String() }),
          detail: { operationId: 'things.get' }
        }
      )

    const { body } = await rpc(app, 'tools/call', {
      name: 'things.get',
      arguments: { params: { id: 'missing' } }
    })

    expect(body.result.isError).toBe(true)
    expect(body.result.content[0].text).toContain('HTTP 404')
    expect(body.result.structuredContent.http.status).toBe(404)
  })

  it('does not treat error response bodies as input-required results', async () => {
    const app = new Elysia().use(mcp({ server, transport: { validateOrigin: false } })).get(
      '/denied-input',
      ({ status }) =>
        status(403, {
          resultType: 'input_required',
          inputRequests: {
            approval: {
              method: 'elicitation/create',
              params: { message: 'Approve?', requestedSchema: { type: 'object' } }
            }
          }
        }),
      { detail: { operationId: 'denied.input' } }
    )

    const { body } = await rpc(app, 'tools/call', {
      name: 'denied.input',
      arguments: {}
    })
    expect(body.result.isError).toBe(true)
    expect(body.result.resultType).toBeUndefined()
    expect(body.result.structuredContent.http.status).toBe(403)
  })

  it('runs beforeHandle guards during route-backed invocation', async () => {
    const app = new Elysia()
      .use(mcp({ server, transport: { validateOrigin: false } }))
      .get('/secure', () => ({ ok: true }), {
        beforeHandle: ({ headers, status }) =>
          headers.authorization === 'let-me-in'
            ? undefined
            : status(401, { error: 'unauthorized' }),
        detail: { operationId: 'secure' }
      })

    const denied = await rpc(app, 'tools/call', { name: 'secure', arguments: {} })
    expect(denied.body.result.isError).toBe(true)

    const allowed = await rpc(
      app,
      'tools/call',
      { name: 'secure', arguments: {} },
      { authorization: 'let-me-in' }
    )
    expect(allowed.body.result.structuredContent).toEqual({ ok: true })
  })

  it('returns input validation errors without invoking the route', async () => {
    const app = new Elysia()
      .use(mcp({ server, transport: { validateOrigin: false } }))
      .get('/users/:id', ({ params }) => ({ id: params.id }), {
        params: t.Object({ id: t.String() }),
        detail: { operationId: 'users.get' }
      })

    const { body } = await rpc(app, 'tools/call', { name: 'users.get', arguments: { params: {} } })

    expect(body.result.isError).toBe(true)
    expect(body.result.structuredContent.code).toBe('MCP_INPUT_VALIDATION_FAILED')
  })

  it('supports flatten input mode', async () => {
    const app = new Elysia()
      .use(mcp({ server, inputMode: 'flatten', transport: { validateOrigin: false } }))
      .get('/users/:id', ({ params, query }) => ({ id: params.id, page: query.page }), {
        params: t.Object({ id: t.String() }),
        query: t.Object({ page: t.Optional(t.String()) }),
        detail: { operationId: 'users.get' }
      })

    const { body } = await rpc(app, 'tools/call', {
      name: 'users.get',
      arguments: { id: 'u_9', page: '2' }
    })

    expect(body.result.structuredContent).toEqual({ id: 'u_9', page: '2' })
  })

  it('supports explicit tools with input validation', async () => {
    const app = new Elysia()
      .use(mcp({ server, allowedRoutes: [], transport: { validateOrigin: false } }))
      .mcpTool('math.add', ({ a, b }: any) => ({ sum: a + b }), {
        inputSchema: {
          type: 'object',
          properties: { a: { type: 'number' }, b: { type: 'number' } },
          required: ['a', 'b'],
          additionalProperties: false
        }
      })

    const ok = await rpc(app, 'tools/call', { name: 'math.add', arguments: { a: 2, b: 3 } })
    expect(ok.body.result.structuredContent).toEqual({ sum: 5 })

    const bad = await rpc(app, 'tools/call', { name: 'math.add', arguments: { a: 2 } })
    expect(bad.body.result.isError).toBe(true)
  })

  it('rejects unknown tools with a JSON-RPC error', async () => {
    const app = new Elysia().use(
      mcp({ server, allowedRoutes: [], transport: { validateOrigin: false } })
    )

    const { body } = await rpc(app, 'tools/call', { name: 'nope', arguments: {} })

    expect(body.error.code).toBe(-32602)
    expect(body.result).toBeUndefined()
  })
})

describe('route exposure', () => {
  it('honors excludedRoutes when allowedRoutes is wildcard', async () => {
    const app = new Elysia()
      .use(mcp({ server, excludedRoutes: ['/private/*'], transport: { validateOrigin: false } }))
      .get('/public/health', () => ({ ok: true }), { detail: { operationId: 'health' } })
      .get('/private/secret', () => ({ secret: true }), { detail: { operationId: 'secret' } })

    const { body } = await rpc(app, 'tools/list')
    const names = body.result.tools.map((tool: any) => tool.name)

    expect(names).toContain('health')
    expect(names).not.toContain('secret')
  })

  it('never exposes its own /mcp endpoint', async () => {
    const app = new Elysia().use(mcp({ server, transport: { validateOrigin: false } }))

    const { body } = await rpc(app, 'tools/list')

    expect(body.result.tools).toEqual([])
  })

  it('treats mcp: false as an opt-out that wins over auto-exposure', async () => {
    const app = new Elysia()
      .use(mcp({ server, transport: { validateOrigin: false } }))
      .get('/hidden', () => ({ ok: true }), { detail: { operationId: 'hidden' }, mcp: false })

    const { body } = await rpc(app, 'tools/list')

    expect(body.result.tools).toEqual([])
  })

  it('throws on cross-source name collisions by default', async () => {
    const app = new Elysia()
      .use(mcp({ server, transport: { validateOrigin: false } }))
      .mcpTool('health', () => 'explicit')
      .get('/health', () => ({ ok: true }), { detail: { operationId: 'health' } })

    const { body } = await rpc(app, 'tools/list')

    expect(body.error.code).toBe(-32603)
    expect(body.error.message).toContain('Duplicate MCP name')
  })

  it('suffixes colliding names when configured', async () => {
    const app = new Elysia()
      .use(mcp({ server, onNameCollision: 'suffix', transport: { validateOrigin: false } }))
      .mcpTool('health', () => 'explicit')
      .get('/health', () => ({ ok: true }), { detail: { operationId: 'health' } })

    const { body } = await rpc(app, 'tools/list')
    const names = body.result.tools.map((tool: any) => tool.name).sort()

    expect(names).toEqual(['health', 'health_2'])
  })
})
