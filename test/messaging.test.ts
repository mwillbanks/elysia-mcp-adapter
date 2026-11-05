import { expect, test } from 'bun:test'
import { Elysia } from 'elysia'
import { getMcpInvocationContext, mcp, mcpInput } from '../src/index.js'
import { modernRpc } from './helpers.js'

const logKey = 'io.modelcontextprotocol/logLevel'
const clientCapabilities = 'io.modelcontextprotocol/clientCapabilities'
const continuation = { signingKey: '0123456789abcdef0123456789abcdef' }

function call(app: Elysia, name: string, meta: Record<string, unknown>, signal?: AbortSignal) {
  return app.handle(
    new Request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2026-07-28',
        'mcp-method': 'tools/call',
        'mcp-name': name
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name,
          arguments: {},
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            [clientCapabilities]: {},
            ...meta
          }
        }
      }),
      signal
    })
  )
}

function frames(stream: string) {
  return stream
    .split('\n')
    .flatMap((line) => (line.startsWith('data: ') ? [JSON.parse(line.slice(6))] : []))
}

test('routes interleaved notifications over one stream and drops messages below the threshold', async () => {
  const app = new Elysia().use(mcp({ allowedRoutes: ['/index'], core: { logging: true } })).get(
    '/index',
    ({ request }) => {
      const context = getMcpInvocationContext(request)
      context?.notify.progress(1, { total: 2 })
      context?.notify.message('filtered')
      context?.notify.message(Symbol('invalid'), { level: 'warning' })
      context?.notify.message({ toJSON: () => undefined }, { level: 'warning' })
      context?.notify.message({ indexed: 1 }, { level: 'warning', logger: 'index' })
      context?.reportProgress?.(2, { total: 2 })
      return new Response('indexed', { headers: { 'content-type': 'text/plain' } })
    },
    { mcp: { name: 'index' } }
  )

  const discover = await modernRpc(app, 'server/discover')
  expect(discover.body.result.capabilities.logging).toEqual({})
  const response = await call(app, 'index', { progressToken: 7, [logKey]: 'warning' })
  expect(response.headers.get('content-type')).toContain('text/event-stream')
  const messages = frames(await response.text())
  expect(messages).toMatchObject([
    { method: 'notifications/progress', params: { progressToken: 7, progress: 1, total: 2 } },
    {
      method: 'notifications/message',
      params: { level: 'warning', logger: 'index', data: { indexed: 1 } }
    },
    { method: 'notifications/progress', params: { progressToken: 7, progress: 2, total: 2 } },
    { id: 1, result: { resultType: 'complete', content: [{ text: 'indexed' }] } }
  ])
  const logOnly = await call(app, 'index', { [logKey]: 'warning' })
  expect(frames(await logOnly.text()).map((message) => message.method)).toEqual([
    'notifications/message',
    undefined
  ])
  const json = await call(app, 'index', {})
  expect(json.headers.get('content-type')).toContain('application/json')
  const invalid = await call(app, 'index', { [logKey]: 'typo', progressToken: 7 })
  expect(await invalid.json()).toMatchObject({ error: { code: -32602 } })
})

test('stops notifications when serialization of the final response begins', async () => {
  const app = new Elysia().use(mcp({ allowedRoutes: [] })).mcpTool('work', (_, { notify }) => {
    notify.progress(1)
    return {
      content: [{ type: 'text', text: 'finished' }],
      structuredContent: {
        toJSON() {
          notify.progress(2)
          queueMicrotask(() => notify.progress(3))
          return { finished: true }
        }
      }
    }
  })
  const response = await call(app, 'work', { progressToken: 'work' })
  expect(frames(await response.text())).toMatchObject([
    { method: 'notifications/progress', params: { progress: 1 } },
    { id: 1, result: { structuredContent: { finished: true } } }
  ])
})

test('does not advertise or open an SSE stream for disabled logging', async () => {
  const app = new Elysia().use(mcp({ allowedRoutes: [] })).mcpTool('work', (_, { notify }) => {
    notify.message('not delivered')
    return 'ok'
  })
  const response = await call(app, 'work', { [logKey]: 'info' })
  expect(response.headers.get('content-type')).toContain('application/json')
  const discover = await modernRpc(app, 'server/discover')
  expect(discover.body.result.capabilities.logging).toBeUndefined()
})

test('request disconnect aborts work and stops pending sends', async () => {
  const stopped = Promise.withResolvers<void>()
  const app = new Elysia().use(mcp({ allowedRoutes: [] })).mcpTool('work', async (_, context) => {
    context.notify.progress(1)
    await new Promise<void>((resolve) => {
      context.signal?.addEventListener('abort', () => resolve(), { once: true })
    })
    context.notify.progress(2)
    stopped.resolve()
    return 'cancelled'
  })
  const disconnect = new AbortController()
  const response = await call(app, 'work', { progressToken: 'live' }, disconnect.signal)
  const reader = response.body!.getReader()
  expect(frames(new TextDecoder().decode((await reader.read()).value))[0]).toMatchObject({
    method: 'notifications/progress'
  })
  disconnect.abort()
  await stopped.promise
  expect(await reader.read()).toMatchObject({ done: true })
})

test('input helpers gate capabilities, renew missing requests, and validate declared answers', async () => {
  const form = mcpInput.form({
    message: 'Confirm',
    requestedSchema: {
      type: 'object',
      properties: { approved: { type: 'boolean' } },
      required: ['approved']
    }
  })
  const requests = {
    form,
    url: mcpInput.url({ message: 'Connect', url: 'https://example.test/connect' }),
    sample: mcpInput.sampling({ messages: [], maxTokens: 8 }),
    roots: mcpInput.roots()
  }
  const app = new Elysia()
    .use(mcp({ allowedRoutes: [], core: { continuation } }))
    .mcpTool('collect', (_, { input }) => {
      if (!Object.values(requests).every((request) => input.supports(request))) return 'fallback'
      const formAnswer = input.response('form', form)
      if (formAnswer?.action === 'decline' || formAnswer?.action === 'cancel') {
        return formAnswer.action
      }
      const outstanding = Object.fromEntries(
        Object.entries(requests).filter(([key, request]) => !input.response(key, request))
      )
      if (Object.keys(outstanding).length) return input.require(outstanding, { state: 'opaque-id' })
      return 'received'
    })
  const params = {
    name: 'collect',
    _meta: {
      [clientCapabilities]: { elicitation: { form: {}, url: {} }, sampling: {}, roots: {} }
    }
  }
  const first = await modernRpc(app, 'tools/call', params)
  expect(first.body.result).toMatchObject({ resultType: 'input_required', inputRequests: requests })
  const follow = (inputResponses: Record<string, unknown>) =>
    modernRpc(app, 'tools/call', {
      ...params,
      requestState: first.body.result.requestState,
      inputResponses
    })
  expect((await follow({ form: { action: 'accept', content: {} } })).body.error.code).toBe(-32602)
  expect((await follow({ form: { roots: [] } })).body.error.code).toBe(-32602)
  expect(
    (await follow({ form: { action: 'accept', content: { approved: true } } })).body.result
      .inputRequests
  ).toEqual({ url: requests.url, sample: requests.sample, roots: requests.roots })
  for (const action of ['decline', 'cancel']) {
    expect((await follow({ form: { action } })).body.result.content[0].text).toBe(action)
  }
  const complete = await follow({
    form: { action: 'accept', content: { approved: true } },
    url: { action: 'accept' },
    sample: { role: 'assistant', content: { type: 'text', text: 'ok' }, model: 'fixture' },
    roots: { roots: [] }
  })
  expect(complete.body.result.content[0].text).toBe('received')
  expect(
    (await modernRpc(app, 'tools/call', { name: 'collect' })).body.result.content[0].text
  ).toBe('fallback')
})
