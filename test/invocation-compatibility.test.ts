import { expect, test } from 'bun:test'
import { Elysia } from 'elysia'
import {
  getMcpInvocationContext,
  getMcpRegistry,
  mcp,
  mcpInput,
  type McpInvocationContext,
  type McpPromptInvocationContext,
  type McpResourceInvocationContext,
  withMcpMethods
} from '../src/index.js'
import { MCP_ROUTE_DETAIL, MCP_ROUTE_OPTIONS } from '../src/elysia-compat.js'
import { normalizeOptions } from '../src/options.js'
import { listRouteOperations } from '../src/route-inspector.js'

const request = new Request('http://localhost/mcp')
const resourceUri = 'test://document'

test('direct registry callers can use legacy contexts with native handlers', async () => {
  const progress: number[] = []
  const roots = mcpInput.roots()
  const answer = { roots: [{ uri: 'file:///documents' }] }
  const base: McpInvocationContext = Object.freeze({
    request,
    protocolVersion: '2026-07-28',
    clientCapabilities: { roots: {} },
    inputResponses: { root: answer },
    reportProgress: (value: number) => {
      progress.push(value)
    }
  })
  const resource: McpResourceInvocationContext = { ...base, uri: resourceUri, variables: {} }
  const prompt: McpPromptInvocationContext = { ...base, name: 'describe' }
  const app = new Elysia()
    .use(withMcpMethods())
    .mcpTool('legacy', (_, context) => {
      expect(context.reportProgress).toBe(base.reportProgress)
      expect(context.input.supports(roots)).toBe(false)
      expect(context.input.response('root', roots)).toEqual(answer)
      context.reportProgress?.(1)
      context.notify.progress(2)
      context.notify.message('No request stream')
      return 'done'
    })
    .mcpResource(resourceUri, ({ input, notify }) => {
      expect(input.supports(roots)).toBe(false)
      notify.progress(3)
      return 'document'
    })
    .mcpPrompt('describe', (_, { input, notify }) => {
      expect(input.supports(roots)).toBe(false)
      notify.progress(4)
      return 'describe the document'
    })

  const registry = getMcpRegistry(app)
  expect(await registry.tools.get('legacy')!.invoke({}, base)).toMatchObject({
    content: [{ text: 'done' }]
  })
  expect(await registry.resources.get(resourceUri)!.read(resource)).toMatchObject({
    contents: [{ text: 'document' }]
  })
  expect(await registry.prompts.get('describe')!.get({}, prompt)).toMatchObject({
    messages: [{ content: { text: 'describe the document' } }]
  })
  expect(progress).toEqual([1, 2, 3, 4])
  expect(base.notify).toBeUndefined()
  expect(base.input).toBeUndefined()
})

test('public registry uses the applied plugin options and accepts an explicit override', () => {
  const app = new Elysia()
    .use(mcp({ allowedRoutes: ['/included'], operationNameResolver: () => 'configured' }))
    .get('/included', () => 'included')
    .get('/excluded', () => 'excluded')
  const registry = getMcpRegistry(app)
  expect([...registry.tools.keys()]).toEqual(['configured'])
  expect(getMcpRegistry(app)).toBe(registry)
  const override = normalizeOptions({
    allowedRoutes: ['/excluded'],
    operationNameResolver: () => 'override'
  })
  expect([...getMcpRegistry(app, override).tools.keys()]).toEqual(['override'])
  expect([...getMcpRegistry(app).tools.keys()]).toEqual(['configured'])
})

test('explicit route metadata replaces captures copied from previously registered hooks', () => {
  const app = new Elysia().use(mcp())
  const shared = { mcp: { name: 'first' } }
  app.get('/capture-source', () => 'first', shared)
  app.get('/capture-renamed', () => 'second', { ...shared, mcp: { name: 'second' } })
  app.get('/capture-hidden', () => 'hidden', { ...shared, mcp: false })
  app.get('/capture-auto', () => 'automatic')

  const registry = getMcpRegistry(app)
  expect([...registry.tools.keys()]).toEqual(['first', 'second', 'get.capture-auto'])
  expect(getMcpRegistry(app)).toBe(registry)
})

test('copied exclusions can be replaced through route and scoped registrations', () => {
  const app = new Elysia().use(mcp()).onAfterHandle(() => undefined)
  const hidden = { mcp: false as const }
  app.get('/route-hidden-source', () => 'hidden', hidden)
  app.route('GET', '/route-visible', () => 'visible', { ...hidden, mcp: { name: 'route-visible' } })
  app.guard({ mcp: false }, (guard) =>
    guard.get('/guard-visible', () => 'visible', { mcp: { name: 'guard-visible' } })
  )
  app.group('/group', { mcp: false }, (group) =>
    group.get('/visible', () => 'visible', { mcp: { name: 'group-visible' } })
  )
  app.use((parent) =>
    parent.group('/outer', (group) => {
      const shared = { mcp: { name: 'nested-first' } }
      return group
        .get('/first', () => 'first', shared)
        .guard({ mcp: false }, (guard) =>
          guard
            .get('/second', () => 'second', { ...shared, mcp: { name: 'nested-second' } })
            .get('/hidden', () => 'hidden', { ...shared, mcp: false })
        )
    })
  )
  const plugin = new Elysia().use(mcp())
  const shared = { mcp: { name: 'plugin-first' } }
  plugin.get('/plugin-first', () => 'first', shared)
  plugin.get('/plugin-second', () => 'second', { ...shared, mcp: { name: 'plugin-second' } })
  app.use(plugin)
  app.guard({ mcp: false }).get('/global-visible', () => 'visible', {
    mcp: { name: 'global-visible' }
  })

  const registry = getMcpRegistry(app)
  expect([...registry.tools.keys()].sort()).toEqual([
    'global-visible',
    'group-visible',
    'guard-visible',
    'nested-first',
    'nested-second',
    'plugin-first',
    'plugin-second',
    'route-visible'
  ])
  expect(getMcpRegistry(app)).toBe(registry)
})

test('all native route entrypoints distinguish copied declarations from replay', () => {
  const app = new Elysia().use(mcp())
  const shared = { mcp: { name: 'entry-source' } }
  app.get('/entry-source', () => 'source', shared)
  for (const method of [
    'get',
    'post',
    'put',
    'patch',
    'delete',
    'options',
    'all',
    'head',
    'connect'
  ] as const) {
    const register = app[method] as (
      path: string,
      handler: () => string,
      hooks: { mcp: { name: string } }
    ) => typeof app
    expect(
      register.call(app, '/entry-' + method, () => method, {
        ...shared,
        mcp: { name: 'entry-' + method }
      })
    ).toBe(app)
  }
  expect(
    app.route('TRACE', '/entry-route', () => 'route', {
      ...shared,
      mcp: { name: 'entry-route' }
    })
  ).toBe(app)
  expect(
    app.ws('/entry-ws', {
      ...shared,
      mcp: { name: 'entry-ws' },
      message() {}
    })
  ).toBe(app)

  const operations = listRouteOperations(app).filter(({ path }) => path.startsWith('/entry-'))
  expect(operations.map(({ mcp }) => mcp && mcp.name).sort()).toEqual([
    'entry-all',
    'entry-connect',
    'entry-delete',
    'entry-get',
    'entry-head',
    'entry-options',
    'entry-patch',
    'entry-post',
    'entry-put',
    'entry-route',
    'entry-source',
    'entry-ws'
  ])
})

test('copied declarations preserve inherited authorization and property descriptors', async () => {
  const app = new Elysia()
  const register = app.get as (...arguments_: any[]) => any
  let forwarded: object | undefined
  Object.defineProperty(app, 'get', {
    configurable: true,
    writable: true,
    value: function (this: Elysia, ...arguments_: any[]) {
      if (arguments_[0] === '/protected-copy') forwarded = arguments_[2]
      return register.apply(this, arguments_)
    }
  })
  const configured = app.use(mcp()).onAfterHandle(() => undefined)
  const shared = { mcp: { name: 'descriptor-source' } }
  configured.get('/descriptor-source', () => 'source', shared)
  const prototype = {
    beforeHandle: () =>
      new Response('Denied', {
        status: 403,
        headers: { 'content-type': 'text/plain' }
      })
  }
  const hooks = Object.create(
    prototype,
    Object.getOwnPropertyDescriptors({
      ...shared,
      mcp: { name: 'descriptor-protected' }
    })
  )
  const auditTag = { get: () => 'audit', enumerable: false, configurable: false }
  Object.defineProperty(hooks, 'auditTag', auditTag)
  Object.defineProperty(hooks, MCP_ROUTE_OPTIONS, {
    ...Object.getOwnPropertyDescriptor(hooks, MCP_ROUTE_OPTIONS),
    configurable: false
  })
  Object.defineProperty(hooks.detail, MCP_ROUTE_DETAIL, {
    ...Object.getOwnPropertyDescriptor(hooks.detail, MCP_ROUTE_DETAIL),
    configurable: false
  })
  configured.get('/protected-copy', () => 'Allowed', hooks)

  expect(Object.getPrototypeOf(forwarded)).toBe(prototype)
  expect(Object.getOwnPropertyDescriptor(forwarded, 'auditTag')).toEqual(auditTag)
  expect(Object.getOwnPropertyDescriptor(hooks, MCP_ROUTE_OPTIONS)?.configurable).toBe(false)
  expect(Object.getOwnPropertyDescriptor(hooks.detail, MCP_ROUTE_DETAIL)?.configurable).toBe(false)
  const response = await app.handle(new Request('http://localhost/protected-copy'))
  expect(response.status).toBe(403)
  const tool = getMcpRegistry(app).tools.get('descriptor-protected')!
  expect(await tool.invoke({}, { request })).toMatchObject({
    isError: true,
    content: [{ text: expect.stringContaining('Denied') }]
  })
})

test('explicit metadata replaces prototype-inherited captures without exposing implicit copies', () => {
  const app = new Elysia().use(mcp()).onAfterHandle(() => undefined)
  const shared = { mcp: false as const }
  app.get('/prototype-source', () => 'hidden', shared)
  Object.defineProperty(shared, MCP_ROUTE_OPTIONS, {
    ...Object.getOwnPropertyDescriptor(shared, MCP_ROUTE_OPTIONS),
    configurable: false,
    writable: false
  })
  const explicit = Object.create(shared, {
    mcp: {
      value: { name: 'prototype-visible' },
      writable: true,
      enumerable: true,
      configurable: true
    }
  })
  app.get('/prototype-visible', () => 'visible', explicit)
  app.get('/prototype-hidden', () => 'hidden', Object.create(shared))
  expect([...getMcpRegistry(app).tools.keys()]).toEqual(['prototype-visible'])
})

test('copied detail accessors retain setter behavior and fresh capture metadata', async () => {
  const app = new Elysia().use(mcp()).onAfterHandle(() => undefined)
  const source = { mcp: false as const }
  app.get('/accessor-source', () => 'source', source)
  const hooks = { ...source, mcp: { name: 'accessor-visible' } } as Record<PropertyKey, any>
  let detail = hooks.detail
  let writes = 0
  const set = (value: unknown) => {
    detail = value
    writes++
  }
  Object.defineProperty(hooks, 'detail', {
    configurable: false,
    enumerable: true,
    get: () => detail,
    set
  })
  app.get('/accessor-visible', () => 'visible', hooks)
  expect(Object.getOwnPropertyDescriptor(hooks, 'detail')?.set).toBe(set)
  expect(writes).toBeGreaterThan(0)
  const registry = getMcpRegistry(app)
  expect([...registry.tools.keys()]).toEqual(['accessor-visible'])
  expect(getMcpRegistry(app)).toBe(registry)
})

test('implicit copied exclusions remain hidden across deferred plugin replay', async () => {
  const plugin = new Elysia().use(mcp({ path: '/deferred-mcp' }))
  const shared = { mcp: false as const }
  plugin.get('/deferred-hidden-source', () => 'hidden', shared)
  plugin.get('/deferred-hidden-copy', () => 'hidden', { ...shared })
  plugin.get('/deferred-visible', () => 'visible', {
    ...shared,
    mcp: { name: 'deferred-visible' }
  })
  const app = new Elysia()
    .use(mcp())
    .get('/deferred-root-visible', () => 'root', { mcp: { name: 'deferred-root-visible' } })
    .use(Promise.resolve(plugin))
  await app.modules
  const expected = ['deferred-root-visible', 'deferred-visible']
  expect([...getMcpRegistry(app).tools.keys()].sort()).toEqual(expected)
  const response = await app.handle(
    new Request('http://localhost/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    })
  )
  const payload = await response.json()
  expect(payload.result.tools.map((tool: { name: string }) => tool.name).sort()).toEqual(expected)
})

const routeCases = [
  { kind: 'tool', failure: false },
  { kind: 'resource', failure: false },
  { kind: 'prompt', failure: false },
  { kind: 'tool', failure: true }
] as const

for (const { kind, failure } of routeCases) {
  test(`route ${kind} retains context until the response body ${failure ? 'fails' : 'finishes'}`, async () => {
    const pullStarted = deferred()
    const release = deferred()
    const progress: number[] = []
    const responseError = new Error('stream failed')
    let routeRequest: Request | undefined
    const app = new Elysia().use(mcp({ allowedRoutes: ['/stream'] })).get(
      '/stream',
      ({ request }) => {
        routeRequest = request
        getMcpInvocationContext(request)?.notify.progress(1)
        return new Response(
          new ReadableStream<Uint8Array>(
            {
              async pull(controller) {
                pullStarted.resolve()
                await release.promise
                getMcpInvocationContext(request)?.notify.progress(2)
                if (failure) {
                  controller.error(responseError)
                  return
                }
                controller.enqueue(new TextEncoder().encode('body'))
                controller.close()
              }
            },
            { highWaterMark: 0 }
          ),
          { headers: { 'content-type': 'text/plain' } }
        )
      },
      { mcp: { kind, name: 'stream', resource: { uri: resourceUri } } }
    )
    const registry = getMcpRegistry(app)
    const context: McpInvocationContext = {
      request,
      reportProgress: (value) => {
        progress.push(value)
      }
    }
    const invocation =
      kind === 'tool'
        ? registry.tools.get('stream')!.invoke({}, context)
        : kind === 'resource'
          ? registry.resources
              .get(resourceUri)!
              .read({ ...context, uri: resourceUri, variables: {} })
          : registry.prompts.get('stream')!.get({}, { ...context, name: 'stream' })

    try {
      await Promise.race([
        pullStarted.promise,
        invocation.then(() => {
          throw new Error('Invocation finished before reading the response stream')
        })
      ])
      expect(progress).toEqual([1])
      expect(getMcpInvocationContext(routeRequest!)).toBeDefined()
    } finally {
      release.resolve()
    }

    if (failure) {
      await expect(invocation).rejects.toThrow(responseError.message)
    } else {
      expect(JSON.stringify(await invocation)).toContain('"text":"body"')
    }
    expect(progress).toEqual([1, 2])
    expect(getMcpInvocationContext(routeRequest!)).toBeUndefined()
  })
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
