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
import { normalizeOptions } from '../src/options.js'

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
