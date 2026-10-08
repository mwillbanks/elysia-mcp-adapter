import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const workspace = resolve(import.meta.dir, '..')
const temporary = mkdtempSync(join(tmpdir(), 'elysia-mcp-packed-'))

async function main(): Promise<void> {
  try {
    await verifyStaticNodeCompatibility()
    await verifyNoGitPrepare()
    await run(['pm', 'pack', '--destination', temporary], workspace)
    const archive = readdirSync(temporary).find((name) => name.endsWith('.tgz'))
    if (!archive) throw new Error('Bun pack did not create an archive')
    const packageArchive = join(temporary, archive)
    await verifyConsumer(packageArchive, '7.0.2', true)
    await verifyConsumer(packageArchive, '5.8.3', false)
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
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
  if (manifest.engines?.node !== '>=20.11')
    throw new Error('The published Node.js compatibility floor must remain >=20.11')
  for (const path of new Bun.Glob('dist/**/*.js').scanSync(workspace)) {
    const source = await Bun.file(join(workspace, path)).text()
    assertCompatibleRuntime(source, path)
  }
}

function assertCompatibleRuntime(source: string, path: string): void {
  if (/\bBun\b/u.test(source))
    throw new Error(`Published runtime contains a Bun-only API reference: ${path}`)
}

async function verifyConsumer(
  archive: string,
  typescript: string,
  execute: boolean
): Promise<void> {
  const directory = join(temporary, `typescript-${typescript}`)
  mkdirSync(directory)
  await Bun.write(
    join(directory, 'package.json'),
    JSON.stringify(
      {
        private: true,
        type: 'module',
        dependencies: {
          '@mwillbanks/elysia-mcp-adapter': archive,
          elysia: '1.4.30'
        },
        devDependencies: { '@types/bun': '1.4.2', '@types/node': '26.6.4', typescript }
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
        skipLibCheck: true
      }
    })
  )
  await Bun.write(join(directory, 'consumer.ts'), consumerSource)
  await run(['install'], directory)
  await run(['--bun', 'node_modules/typescript/bin/tsc', '--noEmit'], directory)
  if (execute) await run(['consumer.ts'], directory)
}

async function run(arguments_: string[], cwd: string): Promise<void> {
  const child = Bun.spawn([process.execPath, ...arguments_], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, HUSKY: '0' }
  })
  const timeout = setTimeout(() => child.kill(), 60_000)
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited
  ]).finally(() => clearTimeout(timeout))
  if (exitCode !== 0)
    throw new Error(
      `Bun ${arguments_.join(' ')} failed (${exitCode})\n${stdout.trim()}\n${stderr.trim()}`
    )
}

const consumerSource = String.raw`
import {
  LEGACY_PROTOCOL_VERSION,
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
new Elysia()
  .use(mcp({
    transport: { protocolVersions: [LEGACY_PROTOCOL_VERSION] },
    allowedRoutes: [],
    extensions: { events: { cursor: { signingKey: 'packed-event-cursor-signing-key-0001' } } }
  }))
  .mcpEvent(eventDefinition, (): McpEventPollResult => ({ events: [], cursor: null }))

const card = await app.handle(new Request('http://localhost/mcp/server-card'))
if (card.status !== 200 || (await card.json()).name !== 'com.example/packed-consumer') {
  throw new Error('Packaged server-card route failed')
}
const response = await app.handle(new Request('http://localhost/mcp', {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'mcp-protocol-version': '2026-07-28',
    'mcp-method': 'skills/list'
  },
  body: JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'skills/list',
    params: { _meta: {
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientInfo': { name: 'packed-consumer', version: '1.0.0' },
      'io.modelcontextprotocol/clientCapabilities': {}
    } }
  })
}))
const listed = await response.json() as { result?: { skills?: McpSkill[] } }
const skill = listed.result?.skills?.[0]
const expectedDigest = 'sha256:' + new Bun.CryptoHasher('sha256').update(skillBytes).digest('hex')
if (!skill || !Array.isArray(skill.resources) || skill.resources[0]?.digest !== expectedDigest) {
  throw new Error('Packaged skill manifest integrity failed')
}
`

await main()
