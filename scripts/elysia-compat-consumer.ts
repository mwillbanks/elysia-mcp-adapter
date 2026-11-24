const v1Syntax = {
  schemaImport: '',
  problemImport: '',
  handlerType: '',
  guardType: '',
  guardFields: 'bearer, status',
  inferenceAssertion: '',
  deny: "status(401, { detail: 'Denied' })",
  options: '',
  layered: '',
  extraTools: '',
  extraAssertions: ''
}

const v2Syntax = {
  schemaImport: "import { z } from 'zod'",
  problemImport: ', problem',
  handlerType: ': { params: { id: string }; request: Request }',
  guardType: ': { bearer?: string }',
  guardFields: 'bearer',
  inferenceAssertion: 'const inferred: IsNotAny<typeof params.id> = true',
  deny: "problem(401, { detail: 'Denied' })",
  options: `{
    mapJsonSchema(schema) {
      if (schema instanceof z.ZodType) return z.toJSONSchema(schema)
      return schema
    }
  }`,
  layered: `
  .macro({ layer: {
    query: t.Object({ inherited: t.String({ minLength: 2 }) }, { additionalProperties: false })
  } })
  .get('/layered', {
    layer: true,
    query: t.Object({ direct: t.String() }, { additionalProperties: false }),
    mcp: { name: 'layered' }
  }, ({ query }: { query: { direct: string; inherited: string } }) => query)
  .post('/standard', {
    body: z.object({ value: z.string() }),
    mcp: { name: 'standard' }
  }, ({ body }: { body: { value: string } }) => body)
  `,
  extraTools: "'layered', 'standard', ",
  extraAssertions: `
const nativeLayered = await app.handle(new Request('http://localhost/layered?direct=one&inherited=two'))
assert.equal(nativeLayered.status, 200)
const layered = await request('tools/call', {
  name: 'layered', arguments: { query: { direct: 'one', inherited: 'two' } }
})
assert.notEqual(layered.isError, true, JSON.stringify(layered))
assert.match(JSON.stringify(layered), /two/)
for (const query of [{ direct: 'one' }, { direct: 'one', inherited: 'x' }, { direct: 'one', inherited: 'two', extra: 'no' }]) {
  const rejected = await request('tools/call', { name: 'layered', arguments: { query } })
  assert.equal(rejected.isError, true, JSON.stringify(rejected))
}
const layerOnly = new Elysia()
  .use(mcp({ diagnostics: { failOnMissingSchema: true } }))
  .macro({ layer: { query: t.Object({ value: t.String() }) } })
  .get('/layer-only', { layer: true, mcp: { name: 'layer-only' } }, ({ query }) => query)
assert.ok(getMcpRegistry(layerOnly).tools.has('layer-only'))
const standard = await request('tools/call', {
  name: 'standard', arguments: { body: { value: 'schema-validated' } }
})
assert.notEqual(standard.isError, true, JSON.stringify(standard))
assert.match(JSON.stringify(standard), /schema-validated/)
`
}

// Emit native route signatures for the Elysia peer installed by pack:check.
export function buildCompatibilitySource(v2: boolean, scope: string): string {
  const syntax = v2 ? v2Syntax : v1Syntax
  const get = (path: string, handler: string, hook: string) =>
    `.get(${JSON.stringify(path)}, ${v2 ? `${hook}, ${handler}` : `${handler}, ${hook}`})`
  const protectedRoute = get(
    '/records/:id',
    `({ params, request }${syntax.handlerType}) => {
      const id: string = params.id
      assert.ok(getMcpInvocationContext(request))
      return { id }
    }`,
    `{
      params: t.Object({ id: t.String() }),
      detail: { operationId: 'records.get', summary: 'Get record' },
      beforeHandle({ ${syntax.guardFields} }${syntax.guardType}) {
        if (bearer !== 'fixture-token') return ${syntax.deny}
      }
    }`
  )
  const inferenceRoute = get(
    '/typed/:id',
    `({ params, request }) => {
      const id: string = params.id
      ${syntax.inferenceAssertion}
      return { id, url: request.url }
    }`,
    `{ params: t.Object({ id: t.String() }), mcp: { name: 'typed' } }`
  )
  const guardOverride = get('/opt-in', `() => 'visible'`, `{ mcp: { name: 'guard-opt-in' } }`)
  const hiddenRoute = get('/hidden', `() => 'hidden'`, `{ mcp: false }`)
  const groupOverride = get('/override', `() => 'visible'`, `{ mcp: { name: 'group-override' } }`)
  const hiddenDocRoute = get('/hidden-doc', `() => 'hidden'`, `{ detail: { hide: true } }`)
  const resourceRoute = get(
    '/summary',
    `() => new Response('summary text', { headers: { 'content-type': 'text/plain' } })`,
    `{ mcp: { kind: 'resource', resource: { uri: 'test://summary' } } }`
  )
  const promptRoute = get(
    '/welcome',
    `() => new Response('Welcome', { headers: { 'content-type': 'text/plain' } })`,
    `{ mcp: { kind: 'prompt', name: 'welcome' } }`
  )

  return `
import assert from 'node:assert/strict'
import { Elysia, t${syntax.problemImport} } from 'elysia'
${syntax.schemaImport}
import { bearer } from '${scope}/bearer'
import { node } from '${scope}/node'
import { openapi } from '${scope}/openapi'
import { opentelemetry } from '${scope}/opentelemetry'
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-node'
import { getMcpInvocationContext, getMcpRegistry, mcp, withMcpMethods } from '@mwillbanks/elysia-mcp-adapter'

type IsNotAny<T> = 0 extends (1 & T) ? false : true
const typed = new Elysia().use(mcp())${inferenceRoute}
assert.ok(getMcpRegistry(typed).tools.has('typed'))

const guarded = new Elysia().use(mcp())
  .guard({ mcp: false }, (group) => group.get('/inherited', () => 'hidden')${guardOverride})
assert.deepEqual([...getMcpRegistry(guarded).tools.keys()], ['guard-opt-in'])

const grouped = new Elysia().use(mcp())
  .group('/group', { mcp: { description: 'group description' } }, (group) => group
    ${hiddenRoute}
    ${groupOverride}
    .get('/inherits', () => 'visible'))
const groupTools = [...getMcpRegistry(grouped).tools.values()]
assert.deepEqual(groupTools.map((tool) => tool.name), ['group-override', 'get.group.inherits'])
assert.equal(groupTools[1].description, 'group description')

const standalone = new Elysia().use(withMcpMethods()).mcpTool('only', () => 'ok')
assert.ok(getMcpRegistry(standalone).tools.has('only'))

const exporter = new InMemorySpanExporter()
const spanProcessor = new SimpleSpanProcessor(exporter)
const app = new Elysia()
  .use(opentelemetry({ autoDetectResources: false, spanProcessors: [spanProcessor] }))
  .use(openapi())
  .use(bearer())
  .use(mcp(${syntax.options}))
  .mcpTool('standalone', () => 'ready')
  .use((parent) => parent.group('/nested', (group) => group${protectedRoute}${hiddenRoute}))
  .use(Promise.resolve(new Elysia()${hiddenDocRoute}))
  ${resourceRoute}${promptRoute}
  ${syntax.layered}

await app.modules

async function request(method: string, params: Record<string, unknown>, token?: string) {
  const response = await app.handle(new Request('http://localhost/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'mcp-protocol-version': '2025-11-25',
      ...(token ? { authorization: 'Bearer ' + token } : {})
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
  }))
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.error, undefined, JSON.stringify(body))
  return body.result
}

const openapiDocument = await app.handle(new Request('http://localhost/openapi/json'))
assert.equal(openapiDocument.status, 200)
const spec = await openapiDocument.json()
assert.equal(spec.paths['/nested/records/{id}'].get.operationId, 'records.get')

const listed = await request('tools/list', {})
assert.deepEqual(listed.tools.map((tool: { name: string }) => tool.name).sort(),
  [${syntax.extraTools}'records.get', 'standalone'].sort())
const args = { name: 'records.get', arguments: { params: { id: 'r1' } } }
const denied = await request('tools/call', args)
assert.equal(denied.isError, true)
assert.match(JSON.stringify(denied), /Denied/)
const allowed = await request('tools/call', args, 'fixture-token')
assert.notEqual(allowed.isError, true)
assert.match(JSON.stringify(allowed), /r1/)

const resource = await request('resources/read', { uri: 'test://summary' })
assert.match(JSON.stringify(resource), /summary text/)
const prompt = await request('prompts/get', { name: 'welcome' })
assert.match(JSON.stringify(prompt), /Welcome/)

${syntax.extraAssertions}

await spanProcessor.forceFlush()
assert.ok(exporter.getFinishedSpans().length > 0, 'Elysia lifecycle should produce traces')

if (!('Bun' in globalThis)) {
  const server = new Elysia({ adapter: node() }).use(mcp({ allowedRoutes: [] }))
  type NodeListener = {
    raw: {
      ready(): Promise<unknown>
      close(): Promise<unknown>
      node: { server: import('node:net').Server }
    }
  }
  const { raw } = await new Promise<NodeListener>((resolve) => {
    server.listen(0, (listener) => resolve(listener as unknown as NodeListener))
  })
  try {
    await raw.ready()
    const address = raw.node.server.address()
    assert.ok(address && typeof address !== 'string')
    const response = await fetch('http://127.0.0.1:' + address.port + '/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })
    })
    assert.equal(response.status, 200)
    assert.deepEqual((await response.json()).result, {})
  } finally {
    await raw.close()
  }
}
`
}

export const aotConsumerSource = String.raw`
import assert from 'node:assert/strict'
import { Elysia, inAotBuild } from 'elysia'
import { mcp } from '@mwillbanks/elysia-mcp-adapter'

export const app = new Elysia()
  .use(mcp())
  .get('/internal', { mcp: false }, () => 'hidden')
  .get('/protected', {
    beforeHandle({ request, status }) {
      if (request.headers.get('authorization') !== 'Bearer fixture') return status(403, 'Denied')
    },
    mcp: { name: 'protected' }
  }, () => 'allowed')

if (!inAotBuild()) {
  const request = async (method: string, params: Record<string, unknown>, authorization?: string) => {
    const response = await app.handle(new Request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(authorization ? { authorization } : {})
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
    }))
    assert.equal(response.status, 200)
    return (await response.json()).result
  }
  const listed = await request('tools/list', {})
  assert.deepEqual(listed.tools.map((tool: { name: string }) => tool.name), ['protected'])
  assert.equal((await request('tools/call', { name: 'protected' })).isError, true)
  assert.notEqual((await request('tools/call', { name: 'protected' }, 'Bearer fixture')).isError, true)
}
`

export const aotBuildSource = String.raw`
import { aot } from 'elysia/plugin/aot/bun'

const result = await Bun.build({
  entrypoints: ['./aot-consumer.ts'],
  outdir: './aot-dist',
  target: 'bun',
  plugins: [aot('./aot-consumer.ts', { target: 'bun' })]
})
if (!result.success) {
  console.error(result.logs)
  process.exit(1)
}
if (!(await result.outputs[0].text()).includes('elysia-aot:manifest'))
  throw new Error('The Elysia AOT build omitted the compiled route manifest')
`

export const benchmarkSource = String.raw`
import { Elysia } from 'elysia'
import { mcp } from '@mwillbanks/elysia-mcp-adapter'
import { version } from 'elysia/package.json' with { type: 'json' }

for (const count of [25, 400]) {
  const app = new Elysia().use(mcp())
  for (let i = 0; i < count; i++) app.get('/route-' + i, () => ({ ok: true }))

  for (const [method, params] of [
    ['tools/list', {}],
    ['tools/call', { name: 'get.route_0' }]
  ]) {
    let name = params.name
    const send = async () => {
      const response = await app.handle(new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: name ? { name } : {} })
      }))
      const payload = await response.json()
      if (!payload.result || payload.result.isError === true) throw new Error(JSON.stringify(payload))
      return payload.result
    }
    if (method === 'tools/call') {
      const response = await app.handle(new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
      }))
      name = (await response.json()).result.tools[0].name
    }
    for (let sample = 0; sample < 100; sample++) await send()
    const batches = []
    for (let batch = 0; batch < 7; batch++) {
      const start = performance.now()
      for (let sample = 0; sample < 100; sample++) await send()
      batches.push((performance.now() - start) / 100)
    }
    batches.sort((left, right) => left - right)
    console.log(version, count, method, batches[3].toFixed(3), 'ms per request')
  }
}
`
