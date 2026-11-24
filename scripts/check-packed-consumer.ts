import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { verifyPackedIntent } from './check-packed-intent'
import {
  aotBuildSource,
  aotConsumerSource,
  benchmarkSource,
  buildCompatibilitySource
} from './elysia-compat-consumer'
import { runBun as run } from './run-bun'

const workspace = resolve(import.meta.dir, '..')
const qualifiedPeers = ['1.4.0', '1.4.32', '2.0.0-rc.5'] as const
type QualifiedPeer = (typeof qualifiedPeers)[number]
const temporary = mkdtempSync(join(tmpdir(), 'elysia-mcp-packed-'))

async function main(): Promise<void> {
  try {
    await verifyNoGitPrepare()
    await run(['pm', 'pack', '--destination', temporary], workspace)
    await verifyStaticNodeCompatibility()
    const archive = readdirSync(temporary).find((name) => name.endsWith('.tgz'))
    if (!archive) throw new Error('Bun pack did not create an archive')
    const packageArchive = join(temporary, archive)
    await verifyPackedIntent(packageArchive)
    for (const elysia of selectedPeers(process.argv.slice(2).filter((entry) => entry !== '--'))) {
      await verifyConsumer(packageArchive, elysia)
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}

function selectedPeers(requested: string[]): readonly QualifiedPeer[] {
  if (requested.length === 0) return qualifiedPeers
  const selection = qualifiedPeers.filter((peer) => requested.includes(peer))
  if (selection.length !== requested.length)
    throw new Error(`Choose distinct Elysia versions from ${qualifiedPeers.join(', ')}`)
  return selection
}

async function verifyNoGitPrepare(): Promise<void> {
  const directory = join(temporary, 'prepare-without-git')
  mkdirSync(directory)
  const workspaceManifest = (await Bun.file(join(workspace, 'package.json')).json()) as {
    scripts?: { prepare?: unknown }
  }
  const prepare = workspaceManifest.scripts?.prepare
  assertBunPrepare(prepare)
  const instrumentedPrepare = `${prepare} && bun -e "await Bun.write('prepare-ran','yes')"`
  await Bun.write(
    join(directory, 'package.json'),
    JSON.stringify({ private: true, scripts: { prepare: instrumentedPrepare } }, null, 2)
  )
  await run(['install'], directory)
  if ((await Bun.file(join(directory, 'prepare-ran')).text()) !== 'yes')
    throw new Error('The no-Git prepare lifecycle did not run')
}

function assertBunPrepare(prepare: unknown): asserts prepare is string {
  if (typeof prepare !== 'string' || !/^bun(?:\s|$)/u.test(prepare))
    throw new Error('The root prepare lifecycle must execute with Bun')
}

async function verifyStaticNodeCompatibility(): Promise<void> {
  const manifest = (await Bun.file(join(workspace, 'package.json')).json()) as {
    engines?: { node?: string }
  }
  if (manifest.engines?.node !== '>=22.18')
    throw new Error('The published Node.js compatibility floor must be >=22.18')
  for (const path of new Bun.Glob('dist/**/*.js').scanSync(workspace)) {
    const source = await Bun.file(join(workspace, path)).text()
    assertCompatibleRuntime(source, path)
  }
}

function assertCompatibleRuntime(source: string, path: string): void {
  if (/\bBun\b/u.test(source))
    throw new Error(`Published runtime contains a Bun-only API reference: ${path}`)
}

const v1Companions = {
  '@elysiajs/openapi': '1.4.17',
  '@elysiajs/bearer': '1.4.4',
  '@elysiajs/opentelemetry': '1.4.11',
  '@elysiajs/node': '1.4.5',
  '@opentelemetry/sdk-trace-node': '2.8.0'
}

const v2Companions = {
  '@elysia/openapi': '2.0.0-rc.1',
  '@elysia/bearer': '2.0.0-rc.0',
  '@elysia/opentelemetry': '2.0.0-rc.0',
  '@elysia/node': '2.0.0-beta.3',
  '@opentelemetry/sdk-trace-node': '2.8.0',
  typebox: '1.4.7',
  zod: '4.6.7'
}

const compatibilityPeers = {
  '1.4.0': { companions: {}, scope: '@elysiajs', version: '1' },
  '1.4.32': { companions: v1Companions, scope: '@elysiajs', version: '1' },
  '2.0.0-rc.5': { companions: v2Companions, scope: '@elysia', version: '2' }
} as const

async function verifyConsumer(archive: string, elysia: QualifiedPeer): Promise<void> {
  const directory = join(temporary, `elysia-${elysia}`)
  const { companions, scope, version } = compatibilityPeers[elysia]
  await stageConsumer(directory, archive, elysia, companions)
  const peerFloor = elysia === '1.4.0'
  if (!peerFloor) {
    await Bun.write(
      join(directory, 'compatibility.ts'),
      buildCompatibilitySource(version === '2', scope)
    )
    await stageDocSnippets(directory, version)
  }
  await run(['install', '--ignore-scripts', '--linker', 'hoisted'], directory)
  await run(['--bun', 'node_modules/typescript/bin/tsc', '--noEmit'], directory)
  await run(['consumer.ts'], directory)
  await run(['consumer.ts'], directory, 'node')
  if (peerFloor) return
  await run(['--bun', 'node_modules/ts5/bin/tsc', '--noEmit'], directory)
  if (version === '2') await verifyReleaseCandidate(directory)
  await verifyIntegrations(directory)
}

async function stageConsumer(
  directory: string,
  archive: string,
  elysia: QualifiedPeer,
  companions: Record<string, string>
): Promise<void> {
  mkdirSync(directory)
  await Bun.write(
    join(directory, 'package.json'),
    JSON.stringify(
      {
        private: true,
        type: 'module',
        dependencies: {
          '@mwillbanks/elysia-mcp-adapter': archive,
          elysia,
          ...companions
        },
        devDependencies: {
          '@types/bun': '1.4.3',
          '@types/node': '24.13.2',
          '@sinclair/typebox': '0.34.52',
          ts5: 'npm:typescript@5.8.3',
          typescript: '7.0.2'
        }
      },
      null,
      2
    )
  )
  await Bun.write(
    join(directory, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        strict: true,
        skipLibCheck: true,
        types: ['node', 'bun']
      }
    })
  )
  const floorProbe = elysia === '1.4.0' ? peerFloorSource : ''
  await Bun.write(join(directory, 'consumer.ts'), consumerSource + floorProbe)
}

async function verifyIntegrations(directory: string): Promise<void> {
  await run(['compatibility.ts'], directory)
  await run(['compatibility.ts'], directory, 'node')
  if (process.env.NODE_ENV === 'production' && process.env.ELYSIA_COMPAT_BENCHMARK) {
    await Bun.write(join(directory, 'benchmark.ts'), benchmarkSource)
    console.log(await run(['benchmark.ts'], directory))
  }
}

async function verifyReleaseCandidate(directory: string): Promise<void> {
  await verifyDpop(directory)
  await verifyAot(directory)
}

async function verifyDpop(directory: string): Promise<void> {
  const test = 'dpop-proof.test.ts'
  const adapter = '@mwillbanks/elysia-mcp-adapter'
  const source = await Bun.file(join(workspace, 'test', test)).text()
  await Bun.write(
    join(directory, test),
    source
      .replace("'../src/index.js'", `'${adapter}'`)
      .replace(
        "'../src/extensions/auth/dpop.js'",
        `'./node_modules/${adapter}/dist/extensions/auth/dpop.js'`
      )
  )
  await run(['test', '--bail', `./${test}`], directory)
}

async function verifyAot(directory: string): Promise<void> {
  await Bun.write(join(directory, 'aot-consumer.ts'), aotConsumerSource)
  await Bun.write(join(directory, 'aot-build.ts'), aotBuildSource)
  await run(['aot-build.ts'], directory)
  await run(['aot-dist/aot-consumer.js'], directory)
}

async function stageDocSnippets(directory: string, version: '1' | '2'): Promise<void> {
  const docs = join(workspace, 'website/content/docs')
  const verifiedPages = {
    'quick-start': 'getting-started',
    'migration-elysia-2': 'getting-started',
    'route-backed-tools': 'core-concepts',
    transportation: 'core-concepts'
  }
  for (const [page, section] of Object.entries(verifiedPages)) {
    const markdown = await Bun.file(join(docs, section, `${page}.mdx`)).text()
    const panes = markdown.matchAll(/<ElysiaVersion value="([12])">([\s\S]*?)<\/ElysiaVersion>/gu)
    const snippets = Array.from(panes)
      .filter((pane) => pane[1] === version)
      .flatMap((pane) =>
        Array.from(pane[2]!.matchAll(/\x60\x60\x60ts\n([\s\S]*?)\n\x60\x60\x60/gu))
      )
      .map((match) => match[1]!)
      .filter((code) => code.startsWith('import '))
    if (snippets.length === 0)
      throw new Error(`Missing Elysia ${version} TypeScript example in ${page}`)
    for (const [index, snippet] of snippets.entries()) {
      await Bun.write(join(directory, `docs-${page}-${index}.ts`), snippet)
    }
  }
}

const peerFloorSource = String.raw`
const floor = new Elysia()
  .use(mcp())
  .get('/visible', () => 'yes')
  .get('/hidden', () => 'no', {
    mcp: false,
    afterHandle() {}
  })
  .guard({ mcp: false }, (group) => group.get('/guarded', () => 'no', {
    mcp: { name: 'guard-opt-in' }
  }))
const floorList = await floor.handle(new Request('http://localhost/mcp', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
}))
const floorTools = (await floorList.json()).result.tools
if (floorTools.length !== 1 || floorTools[0].name !== 'get.visible')
  throw new Error('Elysia 1.4.0 route visibility mismatch: ' + JSON.stringify(floorTools))
`

const consumerSource = String.raw`
import { createHash } from 'node:crypto'
import {
  MCP_EVENTS_CAPABILITY,
  MCP_SERVER_CARD_REVISION,
  MCP_SERVER_CARD_SCHEMA,
  type McpCompletionHandler,
  type McpContinuationProvider,
  type McpEventDefinition,
  type McpEventProvider,
  type McpEventPollResult,
  type McpEventWebhookOptions,
  type McpInputRequiredResult,
  type McpInterceptorDefinition,
  type McpInterceptorHandlerResult,
  type McpInterceptorInvocation,
  type McpSkill,
  type McpSkillProvider,
  type McpSkillRegistrationOptions,
  type McpSubscriptionProvider,
  type McpWebhookSubscriptionProvider,
  mcp
} from '@mwillbanks/elysia-mcp-adapter'
import { Elysia } from 'elysia'

const skillBytes = '---\nname: packed-skill\ndescription: Packed consumer integrity proof\n---\n\n# Packed skill\n'
const app = new Elysia()
  .use(mcp({
    allowedRoutes: [],
    extensions: {
      serverCard: {
        version: MCP_SERVER_CARD_REVISION,
        environment: 'development',
        card: {
          $schema: MCP_SERVER_CARD_SCHEMA,
          name: 'com.example/packed-consumer',
          description: 'Packed consumer',
          version: '1.0.0',
          remotes: [{ type: 'streamable-http', url: 'https://example.com/mcp' }]
        }
      },
      skills: {}
    }
  }))
  .mcpSkill('skill://packed-skill/SKILL.md', skillBytes)
  .mcpInterceptor({
    name: 'packed-interceptor', version: '1', description: 'Packed declarations',
    type: 'validation', hooks: [{ events: ['tools/call'], phase: 'request' }]
  }, (): McpInterceptorHandlerResult => ({ valid: true }))

const eventDefinition: McpEventDefinition = {
  name: 'com.example.packed',
  description: 'Packed event declarations',
  delivery: ['poll'],
  inputSchema: { type: 'object' },
  payloadSchema: { type: 'object' }
}
const eventApp = new Elysia()
  .use(mcp({
    allowedRoutes: [],
    extensions: { events: { cursor: { signingKey: 'packed-event-cursor-signing-key-0001' } } }
  }))
  .mcpEvent(eventDefinition, (): McpEventPollResult => ({ events: [], cursor: null }))

const card = await app.handle(new Request('http://localhost/mcp/server-card'))
if (card.status !== 200 || (await card.json()).name !== 'com.example/packed-consumer') {
  throw new Error('Packaged server-card route failed')
}
function modernRequest(method: string, params: Record<string, unknown> = {}, name?: string) {
  return new Request('http://localhost/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2026-07-28',
      'mcp-method': method,
      ...(name === undefined ? {} : { 'mcp-name': name })
    },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method,
      params: { ...params, _meta: {
        'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        'io.modelcontextprotocol/clientInfo': { name: 'packed-consumer', version: '1.0.0' },
        'io.modelcontextprotocol/clientCapabilities': {}
      } }
    })
  })
}

const discovery = await eventApp.handle(modernRequest('server/discover'))
const discovered = await discovery.json()
if (discovery.status !== 200 || !discovered.result?.capabilities?.extensions?.[MCP_EVENTS_CAPABILITY]) {
  throw new Error('Packaged Events discovery failed')
}
const poll = await eventApp.handle(
  modernRequest('events/poll', { name: eventDefinition.name, arguments: {} }, eventDefinition.name)
)
const polled = await poll.json()
if (poll.status !== 200 || polled.result?.resultType !== 'complete' || !Array.isArray(polled.result?.events)) {
  throw new Error('Packaged Events poll failed')
}
const response = await app.handle(modernRequest('skills/list'))
const listed = await response.json() as { result?: { skills?: McpSkill[] } }
const skill = listed.result?.skills?.[0]
const expectedDigest = 'sha256:' + createHash('sha256').update(skillBytes).digest('hex')
if (!skill || !Array.isArray(skill.resources) || skill.resources[0]?.digest !== expectedDigest) {
  throw new Error('Packaged skill manifest integrity failed')
}
`

await main()
