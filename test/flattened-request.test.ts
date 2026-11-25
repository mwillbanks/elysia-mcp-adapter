import { describe, expect, it } from 'bun:test'
import { Elysia, t } from 'elysia'
import { mcp } from '../src/index.js'
import { normalizeRouteToolInput } from '../src/invoke/build-request.js'
import { normalizeOptions } from '../src/options.js'
import { listRouteOperations } from '../src/route-inspector.js'
import { rpc } from './helpers.js'

const options = normalizeOptions({ inputMode: 'flatten' })

function normalize(
  hooks: Record<string, unknown>,
  input: Record<string, unknown>,
  invocationOptions = options
) {
  const [operation] = listRouteOperations(new Elysia().post('/items/:id', () => null))
  return normalizeRouteToolInput(input, { ...operation!, hooks }, invocationOptions)
}

describe('flattened route invocation', () => {
  it('partitions query and body fields across additive schema layers', () => {
    const input = normalize(
      {
        schemas: [
          { query: t.Object({ page: t.String() }), body: t.Object({ title: t.String() }) },
          { query: t.Object({ locale: t.String() }), body: t.Object({ active: t.Boolean() }) }
        ]
      },
      { id: '42', page: '2', locale: 'en', title: 'Report', active: true }
    )
    expect(input).toEqual({
      params: { id: '42' },
      query: { page: '2', locale: 'en' },
      body: { title: 'Report', active: true }
    })
  })

  it('retains allOf-only body fields inside their advertised value wrapper', () => {
    const input = normalize(
      {
        query: t.Object({ shared: t.String(), page: t.String() }),
        body: { allOf: [t.Object({ shared: t.String() }), t.Object({ title: t.String() })] }
      },
      { shared: 'both', page: '2', value: { shared: 'both', title: 'Report' } }
    )
    expect(input.query).toEqual({ shared: 'both', page: '2' })
    expect(input.body).toEqual({ shared: 'both', title: 'Report' })
  })

  it('partitions mixed object value fields, path parameters, and additional body fields', () => {
    const input = normalize(
      { query: t.Object({ page: t.String() }), body: t.Object({ value: t.Number() }) },
      { id: '42', page: '2', value: 0, extra: 'retained' }
    )
    expect(input).toEqual({
      params: { id: '42' },
      query: { page: '2' },
      body: { value: 0, extra: 'retained' }
    })
    const overlap = normalize(
      { query: t.Object({ page: t.String() }), body: t.Object({ id: t.String() }) },
      { id: '42', page: '2' }
    )
    expect(overlap.body).toEqual({ id: '42' })
  })

  it('uses mapped schemas to match flattened body and query slots', () => {
    const querySchema = { '~standard': { version: 1, vendor: 'test-query' } }
    const bodySchema = { '~standard': { version: 1, vendor: 'test-body' } }
    const calls: string[] = []
    const mappedOptions = normalizeOptions({
      inputMode: 'flatten',
      mapJsonSchema: (schema, context) => {
        calls.push(context.schemaLocation)
        return schema === querySchema
          ? t.Object({ page: t.String() })
          : t.Object({ value: t.Number() })
      }
    })
    const input = normalize(
      { query: querySchema, schemas: [{ body: bodySchema }] },
      { id: '42', page: '2', value: 0 },
      mappedOptions
    )
    expect(input).toEqual({
      params: { id: '42' },
      query: { page: '2' },
      body: { value: 0 }
    })
    expect(calls).toEqual(['query', 'body'])
    calls.length = 0
    normalize({ body: bodySchema }, { value: 0 }, mappedOptions)
    normalize({ query: querySchema }, { page: '2' }, mappedOptions)
    expect(calls).toEqual(['body', 'query'])
  })

  it('preserves historical body-only object passthrough', () => {
    const args = { id: '42', title: 'Report', extra: { retained: true } }
    const input = normalize({ body: t.Object({ title: t.String() }) }, args)
    expect(input.body).toBe(args)
    expect(input.params).toEqual({ id: '42' })
    expect(input.query).toBeUndefined()
  })

  it('partitions closed body layers without dropping fields shared with the path', () => {
    const args = { id: '42', title: 'Report' }
    const closedBody = t.Object({ title: t.String() }, { additionalProperties: false })
    expect(normalize({ body: closedBody }, args)).toEqual({
      params: { id: '42' },
      body: { title: 'Report' }
    })
    expect(normalize({ schemas: [{ body: closedBody }, { body: t.Object({}) }] }, args)).toEqual({
      params: { id: '42' },
      body: { title: 'Report' }
    })
    const sharedBody = t.Object(
      { id: t.String(), title: t.String() },
      { additionalProperties: false }
    )
    expect(normalize({ body: sharedBody }, args)).toEqual({
      params: { id: '42' },
      body: args
    })
  })

  it('preserves primitive body unwrapping alongside query fields', () => {
    const input = normalize(
      { query: t.Object({ page: t.String() }), schemas: [{ body: t.Number() }] },
      { id: '42', page: '2', value: 0 }
    )
    expect(input).toEqual({ params: { id: '42' }, query: { page: '2' }, body: 0 })
  })

  it('preserves query-only routing for undeclared fields', () => {
    expect(normalize({}, { id: '42', page: '2' })).toEqual({
      params: { id: '42' },
      query: { page: '2' }
    })
    expect(normalize({}, { id: '42', value: { page: '2' }, extra: 'retained' })).toEqual({
      params: { id: '42' },
      query: { value: { page: '2' }, extra: 'retained' }
    })
  })

  it('keeps malformed wrapped query values out of unrelated body fields', () => {
    const query = t.Union([t.Object({ page: t.String() }), t.Object({ cursor: t.String() })])
    expect(
      normalize(
        { query, body: t.Object({ title: t.String() }) },
        { id: '42', value: 'invalid', title: 'body', secret: 'never query' }
      )
    ).toEqual({
      params: { id: '42' },
      query: { value: 'invalid' },
      body: { title: 'body', secret: 'never query' }
    })
  })

  it('separates path-only fields from a constrained body with a flat input override', async () => {
    const app = new Elysia({ normalize: false })
      .use(mcp({ inputMode: 'flatten' }))
      .post('/items/:id', ({ params, body }) => ({ params, body }), {
        params: t.Object({ id: t.String() }),
        body: t.Object({ count: t.Number() }, { maxProperties: 1 }),
        mcp: {
          name: 'items.constrained',
          inputSchema: t.Object({ id: t.String(), count: t.Number() })
        }
      })

    const { body } = await rpc(app, 'tools/call', {
      name: 'items.constrained',
      arguments: { id: '42', count: 3 }
    })
    expect(body.result.isError).not.toBe(true)
    expect(body.result.structuredContent).toEqual({ params: { id: '42' }, body: { count: 3 } })
  })

  it('retains path fields declared by a body pattern under a flat input override', async () => {
    const app = new Elysia({ normalize: false })
      .use(mcp({ inputMode: 'flatten' }))
      .post('/items/:id/:label', ({ params, body }) => ({ params, body }), {
        params: t.Object({ id: t.String(), label: t.String() }),
        body: t.Record(t.String({ pattern: '^label$' }), t.String(), {
          additionalProperties: false
        }),
        mcp: {
          name: 'items.pattern',
          inputSchema: t.Object({ id: t.String(), label: t.String() })
        }
      })

    const { body } = await rpc(app, 'tools/call', {
      name: 'items.pattern',
      arguments: { id: '42', label: 'Report' }
    })
    expect(body.result.isError).not.toBe(true)
    expect(body.result.structuredContent).toEqual({
      params: { id: '42', label: 'Report' },
      body: { label: 'Report' }
    })
  })

  it('invokes mixed query and body through Elysia validation', async () => {
    const app = new Elysia()
      .use(mcp({ inputMode: 'flatten', transport: { validateOrigin: false } }))
      .post('/items/:id', ({ params, query, body }) => ({ params, query, body }), {
        params: t.Object({ id: t.String() }),
        query: t.Object({ page: t.String() }),
        body: t.Object({ value: t.Number() }, { additionalProperties: false }),
        detail: { operationId: 'items.create' }
      })
    const { body } = await rpc(app, 'tools/call', {
      name: 'items.create',
      arguments: { id: '42', page: '2', value: 0 }
    })
    expect(body.result.isError).not.toBe(true)
    expect(body.result.structuredContent).toEqual({
      params: { id: '42' },
      query: { page: '2' },
      body: { value: 0 }
    })
  })

  it('unwraps an object-valued query wrapper without a body schema', async () => {
    const app = new Elysia()
      .use(mcp({ inputMode: 'flatten', transport: { validateOrigin: false } }))
      .get('/items/:id', ({ params, query }) => ({ params, query }), {
        params: t.Object({ id: t.String() }),
        query: t.Union([t.Object({ page: t.String() }), t.Object({ cursor: t.String() })]),
        detail: { operationId: 'items.union-query-only' }
      })
    const { body } = await rpc(app, 'tools/call', {
      name: 'items.union-query-only',
      arguments: { id: '42', value: { page: '2' } }
    })
    expect(body.result.isError).not.toBe(true)
    expect(body.result.structuredContent).toEqual({
      params: { id: '42' },
      query: { page: '2' }
    })
  })

  it('unwraps object-valued union query wrappers alongside an object body', async () => {
    const app = new Elysia()
      .use(mcp({ inputMode: 'flatten', transport: { validateOrigin: false } }))
      .post('/items/:id', ({ params, query, body }) => ({ params, query, body }), {
        params: t.Object({ id: t.String() }),
        query: t.Union([t.Object({ page: t.String() }), t.Object({ cursor: t.String() })]),
        body: t.Object({ title: t.String() }),
        detail: { operationId: 'items.union-query' }
      })
    const { body } = await rpc(app, 'tools/call', {
      name: 'items.union-query',
      arguments: { id: '42', value: { page: '2' }, title: 'ok' }
    })
    expect(body.result.isError).not.toBe(true)
    expect(body.result.structuredContent).toEqual({
      params: { id: '42' },
      query: { page: '2' },
      body: { title: 'ok' }
    })
  })

  it('unwraps mapped allOf body wrappers while preserving query fields', async () => {
    const app = new Elysia()
      .use(
        mcp({
          inputMode: 'flatten',
          transport: { validateOrigin: false },
          mapJsonSchema(schema, context) {
            if (context.schemaLocation !== 'body') return schema
            return {
              allOf: [
                { type: 'object', properties: { left: { type: 'string' } } },
                { type: 'object', properties: { right: { type: 'string' } } }
              ]
            }
          }
        })
      )
      .post('/items/:id', ({ params, query, body }) => ({ params, query, body }), {
        params: t.Object({ id: t.String() }),
        query: t.Object({ page: t.String() }),
        body: t.Object({ left: t.String(), right: t.String() }),
        detail: { operationId: 'items.mapped-all-of' }
      })
    const { body } = await rpc(app, 'tools/call', {
      name: 'items.mapped-all-of',
      arguments: { id: '42', page: '2', value: { left: 'a', right: 'b' } }
    })
    expect(body.result.isError).not.toBe(true)
    expect(body.result.structuredContent).toEqual({
      params: { id: '42' },
      query: { page: '2' },
      body: { left: 'a', right: 'b' }
    })
  })

  it('routes named model bodies with explicit input schemas', async () => {
    const app = new Elysia()
      .use(mcp({ inputMode: 'flatten', transport: { validateOrigin: false } }))
      .model('Payload', t.Object({ title: t.String() }))
      .post('/items', ({ body }) => body, {
        body: 'Payload',
        mcp: {
          name: 'items.named',
          inputSchema: {
            type: 'object',
            properties: { title: { type: 'string' } },
            required: ['title']
          }
        }
      })
    const { body } = await rpc(app, 'tools/call', {
      name: 'items.named',
      arguments: { title: 'hello' }
    })
    expect(body.result.isError).not.toBe(true)
    expect(body.result.structuredContent).toEqual({ title: 'hello' })
  })

  it('partitions query fields from a named model body with an explicit input schema', async () => {
    const app = new Elysia()
      .use(mcp({ inputMode: 'flatten', transport: { validateOrigin: false } }))
      .model('Payload', t.Object({ title: t.String() }, { additionalProperties: false }))
      .post('/items', ({ body, query }) => ({ body, query }), {
        body: 'Payload',
        query: t.Object({ page: t.String() }),
        mcp: {
          name: 'items.named-mixed',
          inputSchema: {
            type: 'object',
            properties: { page: { type: 'string' }, title: { type: 'string' } },
            required: ['page', 'title']
          }
        }
      })
    const { body } = await rpc(app, 'tools/call', {
      name: 'items.named-mixed',
      arguments: { page: '2', title: 'hello' }
    })
    expect(body.result.isError).not.toBe(true)
    expect(body.result.structuredContent).toEqual({
      query: { page: '2' },
      body: { title: 'hello' }
    })
  })

  it('keeps a body field named value distinct from query fields', async () => {
    const app = new Elysia()
      .use(mcp({ inputMode: 'flatten', transport: { validateOrigin: false } }))
      .post('/items/:id', ({ params, query, body }) => ({ params, query, body }), {
        params: t.Object({ id: t.String() }),
        query: t.Object({ page: t.String() }),
        body: t.Object({ value: t.Object({ title: t.String() }) }),
        detail: { operationId: 'items.value-body' }
      })
    const { body } = await rpc(app, 'tools/call', {
      name: 'items.value-body',
      arguments: { id: '42', page: '2', value: { title: 'body value' } }
    })
    expect(body.result.isError).not.toBe(true)
    expect(body.result.structuredContent).toEqual({
      params: { id: '42' },
      query: { page: '2' },
      body: { value: { title: 'body value' } }
    })
  })
})
