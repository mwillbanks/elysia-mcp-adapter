import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import Ajv2020Import from 'ajv/dist/2020.js'
import addFormatsImport from 'ajv-formats'
import { Elysia } from 'elysia'
import {
  type McpAdapterState,
  type McpRegistry,
  type McpSkillProvider,
  type McpSkillSource,
  mcp
} from '../src/index.js'
import skillSchema from './fixtures/skills-stable.schema.json' with { type: 'json' }
import { modernRpc } from './helpers.js'

const signingKey = 'skills-pagination-key-0123456789ab'
const Ajv2020 = (Ajv2020Import as any).default ?? Ajv2020Import
const addFormats = (addFormatsImport as any).default ?? addFormatsImport

function skill(name: string, extra = '') {
  return `---\nname: ${name}\ndescription: Use ${name} for tests\nmetadata:\n  owner: tests\n${extra}---\n\n# ${name}\n`
}

describe('Skills over MCP', () => {
  test('keeps pre-Skills public registry and state shapes assignable', () => {
    const registry: McpRegistry = {
      tools: new Map(),
      resources: new Map(),
      resourceTemplates: new Map(),
      prompts: new Map()
    }
    const state: McpAdapterState = {
      explicitTools: new Map(),
      explicitResources: new Map(),
      explicitPrompts: new Map(),
      version: 0,
      registryCache: { fingerprint: '', version: 0, registry }
    }
    expect(state.registryCache?.registry).toBe(registry)
  })

  test('advertises only configured Skills and resource capabilities', async () => {
    const plain = new Elysia().use(mcp({ allowedRoutes: [] }))
    const plainDiscover = await modernRpc(plain, 'server/discover')
    expect(plainDiscover.body.result.capabilities.extensions).toBeUndefined()
    expect(plainDiscover.body.result.capabilities.resources).toBeUndefined()

    const configured = new Elysia()
      .use(mcp({ allowedRoutes: [] }))
      .mcpSkill('skill://capability/SKILL.md', skill('capability'))
    const discover = await modernRpc(configured, 'server/discover')
    expect(discover.body.result.capabilities.resources).toBeDefined()
    expect(discover.body.result.capabilities.extensions['io.modelcontextprotocol/skills']).toEqual({
      directoryRead: false
    })
  })

  test('isolates Skills provider capabilities between endpoints on one app', async () => {
    const provider: McpSkillProvider = {
      list: () => ({ skills: [] }),
      get: () => null,
      read: () => null
    }
    const app = new Elysia()
      .use(mcp({ path: '/plain', allowedRoutes: [] }))
      .use(mcp({ path: '/skills', allowedRoutes: [], extensions: { skills: { provider } } }))

    const discover = async (path: string) => {
      const response = await app.handle(
        new Request(`http://localhost${path}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            'mcp-protocol-version': '2026-07-28',
            'mcp-method': 'server/discover'
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'server/discover',
            params: {
              _meta: {
                'io.modelcontextprotocol/protocolVersion': '2026-07-28',
                'io.modelcontextprotocol/clientInfo': { name: 'test', version: '1.0.0' },
                'io.modelcontextprotocol/clientCapabilities': {}
              }
            }
          })
        })
      )
      return (await response.json()) as any
    }

    expect((await discover('/plain')).result.capabilities.extensions).toBeUndefined()
    expect(
      (await discover('/skills')).result.capabilities.extensions['io.modelcontextprotocol/skills']
    ).toEqual({ directoryRead: false })
    expect((await discover('/plain')).result.capabilities.extensions).toBeUndefined()
  })

  test('publishes complete byte-bound manifests and reads supporting files', async () => {
    const skillBytes = new TextEncoder().encode(skill('integrity'))
    const guide = new TextEncoder().encode('# Guide\n')
    const app = new Elysia()
      .use(mcp({ allowedRoutes: [] }))
      .mcpSkill('skill://integrity/SKILL.md', skillBytes, {
        resources: { 'references/GUIDE.md': { content: guide, mimeType: 'text/markdown' } }
      })

    skillBytes.fill(0)
    guide.fill(0)

    const listed = await modernRpc(app, 'skills/list')
    expect(listed.body.result).toMatchObject({
      resultType: 'complete',
      ttlMs: 0,
      cacheScope: 'private'
    })
    const entry = listed.body.result.skills[0]
    const ajv = new Ajv2020({ strict: true })
    addFormats(ajv)
    expect(ajv.validate(skillSchema, entry)).toBe(true)
    expect(entry.frontmatter).toEqual({
      name: 'integrity',
      description: 'Use integrity for tests',
      metadata: { owner: 'tests' }
    })
    expect(entry.resources).toHaveLength(2)

    const read = await modernRpc(app, 'resources/read', {
      uri: 'skill://integrity/references/GUIDE.md'
    })
    expect(read.body.result.contents[0].text).toBe('# Guide\n')
    const raw = new TextEncoder().encode(read.body.result.contents[0].text)
    const manifest = entry.resources.find((resource: { uri: string }) =>
      resource.uri.endsWith('/GUIDE.md')
    )
    expect(manifest.size).toBe(raw.byteLength)
    expect(manifest.digest).toBe(`sha256:${createHash('sha256').update(raw).digest('hex')}`)
  })

  test('preserves a UTF-8 BOM while parsing frontmatter from the same bytes', async () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(skill('bom'))])
    const app = new Elysia().use(mcp({ allowedRoutes: [] })).mcpSkill('skill://bom/SKILL.md', bytes)
    const read = await modernRpc(app, 'resources/read', { uri: 'skill://bom/SKILL.md' })
    expect(read.body.result.contents[0].text.codePointAt(0)).toBe(0xfeff)
    const listed = await modernRpc(app, 'skills/list')
    expect(listed.body.result.skills[0].resources[0].size).toBe(bytes.byteLength)
  })

  test('renders bounded YAML aliases and preserves experimental allowed-tools', async () => {
    const source = `---
name: aliases
description: Preserve delegated frontmatter fields
allowed-tools: Bash(git:*) Read
defaults: &defaults
  - one
  - two
copy: *defaults
---
# Aliases
`
    const app = new Elysia()
      .use(mcp({ allowedRoutes: [] }))
      .mcpSkill('skill://aliases/SKILL.md', source)
    const result = await modernRpc(app, 'skills/get', { uri: 'skill://aliases/SKILL.md' })
    expect(result.body.result.skill.frontmatter).toMatchObject({
      'allowed-tools': 'Bash(git:*) Read',
      defaults: ['one', 'two'],
      copy: ['one', 'two']
    })
  })

  test('accepts normalized lowercase Unicode names and rejects invalid UTF-8', () => {
    expect(() =>
      new Elysia()
        .use(mcp({ allowedRoutes: [] }))
        .mcpSkill('skill://caf%C3%A9/SKILL.md', skill('café'))
    ).not.toThrow()
    expect(() =>
      new Elysia()
        .use(mcp({ allowedRoutes: [] }))
        .mcpSkill('skill://%EF%BD%81%EF%BC%91/SKILL.md', skill('ａ１'))
    ).not.toThrow()
    expect(() =>
      new Elysia()
        .use(mcp({ allowedRoutes: [] }))
        .mcpSkill(
          'skill://broken/SKILL.md',
          new Uint8Array([0xff, ...new TextEncoder().encode(skill('broken'))])
        )
    ).toThrow('valid UTF-8')
  })

  test('rejects traversal and binary resources unless explicitly enabled', () => {
    const base = new Elysia().use(mcp({ allowedRoutes: [] }))
    expect(() =>
      base.mcpSkill('skill://safe/SKILL.md', skill('safe'), {
        resources: { '../secret.txt': 'no' }
      })
    ).toThrow('unsafe path segment')
    expect(() =>
      base.mcpSkill('skill://safe/SKILL.md', skill('safe'), {
        resources: { 'asset.bin': new Uint8Array([0xff]) }
      })
    ).toThrow('allowBinary')
    expect(() =>
      base.mcpSkill('skill://mime-binary/SKILL.md', skill('mime-binary'), {
        resources: {
          'asset.bin': { content: 'ABC', mimeType: 'application/octet-stream' }
        }
      })
    ).toThrow('allowBinary')
  })

  test('serves explicitly opted-in binary resources as base64 blobs', async () => {
    const app = new Elysia()
      .use(mcp({ allowedRoutes: [] }))
      .mcpSkill('skill://binary/SKILL.md', skill('binary'), {
        allowBinary: true,
        resources: {
          'asset.bin': { content: 'ABC', mimeType: 'application/octet-stream' }
        }
      })
    const read = await modernRpc(app, 'resources/read', { uri: 'skill://binary/asset.bin' })
    expect(read.body.result.contents[0]).toMatchObject({
      mimeType: 'application/octet-stream',
      blob: 'QUJD'
    })
    expect(Buffer.from(read.body.result.contents[0].blob, 'base64').toString()).toBe('ABC')
  })

  test('rejects whitespace URIs and conflicting nested resource snapshots', async () => {
    expect(() =>
      new Elysia()
        .use(mcp({ allowedRoutes: [] }))
        .mcpSkill('skill://bad name/SKILL.md', skill('bad-name'))
    ).toThrow('Invalid absolute skill resource URI')

    const nestedBytes = skill('nested')
    const valid = new Elysia()
      .use(mcp({ allowedRoutes: [] }))
      .mcpSkill('skill://outer/SKILL.md', skill('outer'), {
        resources: { 'nested/SKILL.md': nestedBytes }
      })
      .mcpSkill('skill://outer/nested/SKILL.md', nestedBytes)
    const read = await modernRpc(valid, 'resources/read', {
      uri: 'skill://outer/nested/SKILL.md'
    })
    expect(read.body.result.contents[0].text).toBe(nestedBytes)

    const conflicting = new Elysia()
      .use(mcp({ allowedRoutes: [] }))
      .mcpSkill('skill://outer/SKILL.md', skill('outer'), {
        resources: { 'nested/SKILL.md': nestedBytes }
      })
      .mcpSkill('skill://outer/nested/SKILL.md', `${nestedBytes}\nchanged`)
    const discovered = await modernRpc(conflicting, 'server/discover')
    expect(discovered.body.error.message).toContain('identical bytes and metadata')

    const incompleteNested = new Elysia()
      .use(mcp({ allowedRoutes: [], extensions: { skills: { directoryRead: true } } }))
      .mcpSkill('skill://complete-outer/SKILL.md', skill('complete-outer'), {
        resources: {
          'nested/SKILL.md': nestedBytes,
          'nested/extra.txt': 'must appear in both manifests'
        }
      })
      .mcpSkill('skill://complete-outer/nested/SKILL.md', nestedBytes)
    const incompleteDiscovery = await modernRpc(incompleteNested, 'server/discover')
    expect(incompleteDiscovery.body.error.message).toContain('must include enclosing resource')

    const incompleteDirectory = new Elysia()
      .use(mcp({ allowedRoutes: [], extensions: { skills: { directoryRead: true } } }))
      .mcpSkill('skill://directory-outer/SKILL.md', skill('directory-outer'), {
        resources: { 'nested/SKILL.md': nestedBytes },
        directories: ['nested/empty']
      })
      .mcpSkill('skill://directory-outer/nested/SKILL.md', nestedBytes)
    const directoryDiscovery = await modernRpc(incompleteDirectory, 'server/discover')
    expect(directoryDiscovery.body.error.message).toContain('must include enclosing directory')
  })

  test('keeps complete nested directory ownership and authorization atomic', async () => {
    const nestedBytes = skill('nested')
    const extra = 'shared nested file'
    const app = new Elysia()
      .use(
        mcp({
          allowedRoutes: [],
          extensions: {
            auth: {
              resource: 'https://api.example.test/mcp',
              authorizationServers: ['https://auth.example.test'],
              verifyAccessToken: (token) => ({
                tokenType: 'access_token',
                subject: token,
                issuer: 'https://auth.example.test',
                audience: 'https://api.example.test/mcp',
                expiresAt: Math.floor(Date.now() / 1000) + 60,
                scopes: token === 'allowed' ? ['nested:read'] : []
              })
            },
            skills: { directoryRead: true }
          }
        })
      )
      .mcpSkill('skill://authorized-outer/SKILL.md', skill('authorized-outer'), {
        resources: {
          'nested/SKILL.md': nestedBytes,
          'nested/extra.txt': extra
        },
        directories: ['nested/empty']
      })
      .mcpSkill('skill://authorized-outer/nested/SKILL.md', nestedBytes, {
        resources: { 'extra.txt': extra },
        directories: ['empty'],
        authorization: { requiredScopes: ['nested:read'] }
      })

    const denied = await modernRpc(
      app,
      'resources/directory/read',
      { uri: 'skill://authorized-outer/nested' },
      { authorization: 'Bearer denied' }
    )
    expect(denied.status).toBe(403)
    const allowed = await modernRpc(
      app,
      'resources/directory/read',
      { uri: 'skill://authorized-outer/nested' },
      { authorization: 'Bearer allowed' }
    )
    expect(allowed.body.result.resources.map((entry: { name: string }) => entry.name)).toEqual([
      'SKILL.md',
      'extra.txt',
      'empty'
    ])
  })

  test('rejects mixed dynamic and static nested namespaces in either direction', async () => {
    const nestedBytes = skill('nested')
    const dynamicOuter = new Elysia()
      .use(mcp({ allowedRoutes: [], extensions: { skills: { directoryRead: true } } }))
      .mcpSkill('skill://mixed-outer/SKILL.md', skill('mixed-outer'), {
        resources: 'dynamic',
        readResource: () => null,
        readDirectory: () => ({ resources: [] })
      })
      .mcpSkill('skill://mixed-outer/nested/SKILL.md', nestedBytes)
    const outerDiscovery = await modernRpc(dynamicOuter, 'server/discover')
    expect(outerDiscovery.body.error.message).toContain(
      'Nested skill namespaces require static complete resource manifests'
    )

    const dynamicInner = new Elysia()
      .use(mcp({ allowedRoutes: [], extensions: { skills: { directoryRead: true } } }))
      .mcpSkill('skill://mixed-inner/SKILL.md', skill('mixed-inner'), {
        resources: { 'nested/SKILL.md': nestedBytes, 'nested/extra.txt': 'extra' }
      })
      .mcpSkill('skill://mixed-inner/nested/SKILL.md', nestedBytes, {
        resources: 'dynamic',
        readResource: () => null,
        readDirectory: () => ({ resources: [] })
      })
    const innerDiscovery = await modernRpc(dynamicInner, 'server/discover')
    expect(innerDiscovery.body.error.message).toContain(
      'Nested skill namespaces require static complete resource manifests'
    )
  })

  test('lists direct directory children, including explicit empty directories through providers', async () => {
    const provider: McpSkillProvider = {
      list: () => ({ skills: [] }),
      get: (uri) =>
        uri === 'skill://dynamic/SKILL.md'
          ? { uri, skill: skill('dynamic'), resources: 'dynamic' }
          : null,
      read: () => null,
      readDirectory: (uri) => (uri === 'skill://dynamic/empty' ? { resources: [] } : null)
    }
    const app = new Elysia()
      .use(
        mcp({
          allowedRoutes: [],
          extensions: { skills: { directoryRead: true, provider } }
        })
      )
      .mcpSkill('skill://files/SKILL.md', skill('files'), {
        directories: ['empty'],
        resources: {
          'references/ONE.md': 'one',
          'references/deep/TWO.md': 'two'
        }
      })

    const root = await modernRpc(app, 'resources/directory/read', { uri: 'skill://files' })
    expect(root.body.result.resources).toEqual([
      expect.objectContaining({ name: 'SKILL.md', mimeType: 'text/markdown' }),
      expect.objectContaining({ name: 'references', mimeType: 'inode/directory' }),
      expect.objectContaining({ name: 'empty', mimeType: 'inode/directory' })
    ])
    const direct = await modernRpc(app, 'resources/directory/read', {
      uri: 'skill://files/references'
    })
    expect(direct.body.result.resources.map((item: { name: string }) => item.name)).toEqual([
      'ONE.md',
      'deep'
    ])
    const empty = await modernRpc(app, 'resources/directory/read', {
      uri: 'skill://dynamic/empty'
    })
    expect(empty.body.result.resources).toEqual([])
  })

  test('computes static provider directories without a directory callback', async () => {
    const source = {
      uri: 'skill://provider-static/SKILL.md',
      skill: skill('provider-static'),
      resources: {
        'root.txt': 'root',
        'nested/deep.txt': 'deep'
      },
      directories: ['empty', 'nested/empty']
    }
    const provider: McpSkillProvider = {
      list: () => ({ skills: [source] }),
      get: (uri) => (uri === source.uri ? source : null),
      read: () => null
    }
    const app = new Elysia().use(
      mcp({ allowedRoutes: [], extensions: { skills: { directoryRead: true, provider } } })
    )

    const root = await modernRpc(app, 'resources/directory/read', {
      uri: 'skill://provider-static'
    })
    expect(root.body.result.resources.map((entry: { name: string }) => entry.name)).toEqual([
      'SKILL.md',
      'root.txt',
      'nested',
      'empty'
    ])
    const nested = await modernRpc(app, 'resources/directory/read', {
      uri: 'skill://provider-static/nested'
    })
    expect(nested.body.result.resources.map((entry: { name: string }) => entry.name)).toEqual([
      'deep.txt',
      'empty'
    ])
    const empty = await modernRpc(app, 'resources/directory/read', {
      uri: 'skill://provider-static/empty'
    })
    expect(empty.body.result.resources).toEqual([])
  })

  test('rejects dynamic provider publications without directory enumeration', async () => {
    const source = {
      uri: 'skill://provider-dynamic/SKILL.md',
      skill: skill('provider-dynamic'),
      resources: 'dynamic' as const
    }
    const provider: McpSkillProvider = {
      list: () => ({ skills: [source] }),
      get: (uri) => (uri === source.uri ? source : null),
      read: (uri) => (uri.endsWith('/live.txt') ? 'live' : null)
    }
    const app = new Elysia().use(
      mcp({ allowedRoutes: [], extensions: { skills: { directoryRead: true, provider } } })
    )

    for (const [method, params] of [
      ['skills/list', {}],
      ['skills/get', { uri: source.uri }],
      ['resources/read', { uri: 'skill://provider-dynamic/live.txt' }],
      ['resources/directory/read', { uri: 'skill://provider-dynamic' }]
    ] as const) {
      const response = await modernRpc(app, method, params)
      expect(response.body.error.code).toBe(-32603)
      expect(response.body.error.message).toContain('requires readDirectory')
    }
  })

  test('supports signed atomic pages and direct lookup outside the listing', async () => {
    const app = new Elysia()
      .use(
        mcp({
          allowedRoutes: [],
          extensions: {
            skills: {
              pagination: { pageSize: 1, signingKey }
            }
          }
        })
      )
      .mcpSkill('skill://one/SKILL.md', skill('one'), {
        resources: { 'large.txt': 'x'.repeat(4096) }
      })
      .mcpSkill('skill://hidden/SKILL.md', skill('hidden'), { listed: false })
      .mcpSkill('skill://two/SKILL.md', skill('two'))

    const first = await modernRpc(app, 'skills/list')
    expect(first.body.result.skills).toHaveLength(1)
    expect(first.body.result.skills[0].resources).toHaveLength(2)
    const second = await modernRpc(app, 'skills/list', { cursor: first.body.result.nextCursor })
    expect(second.body.result.skills.map((item: { uri: string }) => item.uri)).toEqual([
      'skill://two/SKILL.md'
    ])
    const direct = await modernRpc(app, 'skills/get', { uri: 'skill://hidden/SKILL.md' })
    expect(direct.body.result.skill.frontmatter.name).toBe('hidden')
    const tampered = await modernRpc(app, 'skills/list', {
      cursor: `${first.body.result.nextCursor}x`
    })
    expect(tampered.body.error.code).toBe(-32602)
  })

  test('does not ask providers to read unpublished or cross-skill resources', async () => {
    const reads: string[] = []
    const provider: McpSkillProvider = {
      list: () => ({ skills: [] }),
      get: (uri) =>
        uri === 'skill://owned/SKILL.md'
          ? { uri, skill: skill('owned'), resources: 'dynamic' }
          : null,
      read: (uri) => {
        reads.push(uri)
        return 'dynamic'
      }
    }
    const app = new Elysia().use(mcp({ allowedRoutes: [], extensions: { skills: { provider } } }))
    const unknown = await modernRpc(app, 'resources/read', {
      uri: 'skill://unowned/private.txt'
    })
    expect(unknown.body.error.code).toBe(-32602)
    expect(reads).toEqual([])

    const owned = await modernRpc(app, 'resources/read', { uri: 'skill://owned/live.txt' })
    expect(owned.body.result.contents[0].text).toBe('dynamic')
    expect(reads).toEqual(['skill://owned/live.txt'])
  })

  test('serves explicitly declared dynamic resources without a provider', async () => {
    let revision = 0
    const app = new Elysia()
      .use(mcp({ allowedRoutes: [] }))
      .mcpSkill('skill://generated/SKILL.md', skill('generated'), {
        resources: 'dynamic',
        readResource: (uri) =>
          uri === 'skill://generated/live.txt' ? `revision-${++revision}` : null
      })
    const manifest = await modernRpc(app, 'skills/get', {
      uri: 'skill://generated/SKILL.md'
    })
    expect(manifest.body.result.skill.resources).toBe('dynamic')
    const first = await modernRpc(app, 'resources/read', {
      uri: 'skill://generated/live.txt'
    })
    const second = await modernRpc(app, 'resources/read', {
      uri: 'skill://generated/live.txt'
    })
    expect(first.body.result.contents[0].text).toBe('revision-1')
    expect(second.body.result.contents[0].text).toBe('revision-2')
  })

  test('enumerates explicit dynamic directories with strict direct-child metadata', async () => {
    const app = new Elysia()
      .use(
        mcp({
          allowedRoutes: [],
          extensions: {
            auth: {
              resource: 'https://api.example.test/mcp',
              authorizationServers: ['https://auth.example.test'],
              verifyAccessToken: (token) => ({
                tokenType: 'access_token',
                subject: token,
                issuer: 'https://auth.example.test',
                audience: 'https://api.example.test/mcp',
                expiresAt: Math.floor(Date.now() / 1000) + 60,
                scopes: token === 'allowed' ? ['dynamic:read'] : []
              })
            },
            skills: {
              directoryRead: true,
              pagination: { pageSize: 2, signingKey }
            }
          }
        })
      )
      .mcpSkill('skill://dynamic-local/SKILL.md', skill('dynamic-local'), {
        resources: 'dynamic',
        directories: ['known-empty'],
        authorization: { requiredScopes: ['dynamic:read'] },
        readResource: (uri) => (uri.endsWith('/live.txt') ? 'live' : null),
        readDirectory: (uri) => {
          if (uri === 'skill://dynamic-local') {
            return {
              resources: [
                {
                  uri: 'skill://dynamic-local/live.txt',
                  name: 'live.txt',
                  mimeType: 'text/plain',
                  size: 4
                },
                {
                  uri: 'skill://dynamic-local/nested',
                  name: 'nested',
                  mimeType: 'inode/directory'
                }
              ]
            }
          }
          return uri === 'skill://dynamic-local/nested' ||
            uri === 'skill://dynamic-local/known-empty'
            ? { resources: [] }
            : null
        }
      })

    const denied = await modernRpc(
      app,
      'resources/directory/read',
      { uri: 'skill://dynamic-local' },
      { authorization: 'Bearer denied' }
    )
    expect(denied.status).toBe(403)
    const root = await modernRpc(
      app,
      'resources/directory/read',
      { uri: 'skill://dynamic-local' },
      { authorization: 'Bearer allowed' }
    )
    expect(root.body.result.resources).toEqual([
      expect.objectContaining({ name: 'SKILL.md', mimeType: 'text/markdown' }),
      expect.objectContaining({ name: 'known-empty', mimeType: 'inode/directory' })
    ])
    const generated = await modernRpc(
      app,
      'resources/directory/read',
      { uri: 'skill://dynamic-local', cursor: root.body.result.nextCursor },
      { authorization: 'Bearer allowed' }
    )
    expect(generated.body.result.resources).toEqual([
      expect.objectContaining({ name: 'live.txt', mimeType: 'text/plain', size: 4 }),
      expect.objectContaining({ name: 'nested', mimeType: 'inode/directory' })
    ])
    const empty = await modernRpc(
      app,
      'resources/directory/read',
      { uri: 'skill://dynamic-local/nested' },
      { authorization: 'Bearer allowed' }
    )
    expect(empty.body.result.resources).toEqual([])
  })

  test('fails closed for incomplete or malformed dynamic directory readers', async () => {
    const incomplete = new Elysia()
      .use(mcp({ allowedRoutes: [], extensions: { skills: { directoryRead: true } } }))
      .mcpSkill('skill://incomplete-dynamic/SKILL.md', skill('incomplete-dynamic'), {
        resources: 'dynamic',
        readResource: () => 'live'
      })
    const discovery = await modernRpc(incomplete, 'server/discover')
    expect(discovery.body.error.message).toContain('requires readDirectory')

    let mode: 'traversal' | 'conflict' | 'size' | 'malformed' = 'traversal'
    const malformed = new Elysia()
      .use(mcp({ allowedRoutes: [], extensions: { skills: { directoryRead: true } } }))
      .mcpSkill('skill://malformed-dynamic/SKILL.md', skill('malformed-dynamic'), {
        resources: 'dynamic',
        readResource: () => null,
        readDirectory: () => {
          if (mode === 'malformed') return { resources: 'bad' } as any
          const entry =
            mode === 'traversal'
              ? { uri: 'skill://malformed-dynamic/%2e%2e/private', name: 'private' }
              : mode === 'conflict'
                ? {
                    uri: 'skill://malformed-dynamic/SKILL.md',
                    name: 'SKILL.md',
                    mimeType: 'text/markdown'
                  }
                : {
                    uri: 'skill://malformed-dynamic/file.txt',
                    name: 'file.txt',
                    size: -1
                  }
          return { resources: [entry] }
        }
      })
    for (const next of ['traversal', 'conflict', 'size', 'malformed'] as const) {
      mode = next
      const result = await modernRpc(malformed, 'resources/directory/read', {
        uri: 'skill://malformed-dynamic'
      })
      expect(result.body.error.code).toBe(-32603)
    }
  })

  test('filters provider pages by scope without skipping entries and binds cursors to principals', async () => {
    const sources = [
      { uri: 'skill://public/SKILL.md', skill: skill('public') },
      {
        uri: 'skill://secret/SKILL.md',
        skill: skill('secret'),
        authorization: { requiredScopes: ['skills:secret'] }
      },
      { uri: 'skill://third/SKILL.md', skill: skill('third') },
      { uri: 'skill://fourth/SKILL.md', skill: skill('fourth') }
    ]
    const offsets: number[] = []
    const provider: McpSkillProvider = {
      list: ({ offset, limit }) => {
        offsets.push(offset)
        const end = offset + (limit ?? sources.length)
        return { skills: sources.slice(offset, end), hasMore: end < sources.length }
      },
      get: (uri) => sources.find((source) => source.uri === uri) ?? null,
      read: () => null
    }
    const app = new Elysia().use(
      mcp({
        allowedRoutes: [],
        extensions: {
          auth: {
            resource: 'https://api.example.test/mcp',
            authorizationServers: ['https://auth.example.test'],
            verifyAccessToken: (token) => ({
              tokenType: 'access_token',
              subject: token,
              issuer: 'https://auth.example.test',
              audience: 'https://api.example.test/mcp',
              expiresAt: Math.floor(Date.now() / 1000) + 60,
              scopes: []
            })
          },
          skills: { provider, pagination: { pageSize: 2, signingKey } }
        }
      })
    )

    const first = await modernRpc(app, 'skills/list', {}, { authorization: 'Bearer alice' })
    expect(first.body.result.skills[0].frontmatter.name).toBe('public')
    expect(offsets).toEqual([0])
    const second = await modernRpc(
      app,
      'skills/list',
      { cursor: first.body.result.nextCursor },
      { authorization: 'Bearer alice' }
    )
    expect(second.body.result.skills.map((entry: any) => entry.frontmatter.name)).toEqual([
      'third',
      'fourth'
    ])
    expect(offsets).toEqual([0, 2])
    const rebound = await modernRpc(
      app,
      'skills/list',
      { cursor: first.body.result.nextCursor },
      { authorization: 'Bearer bob' }
    )
    expect(rebound.body.error.code).toBe(-32602)
    const forbidden = await modernRpc(
      app,
      'skills/get',
      { uri: 'skill://secret/SKILL.md' },
      { authorization: 'Bearer alice' }
    )
    expect(forbidden.status).toBe(403)
  })

  test('enforces extension authorization for static get and resource reads', async () => {
    const app = new Elysia()
      .use(
        mcp({
          allowedRoutes: [],
          extensions: {
            auth: {
              resource: 'https://api.example.test/mcp',
              authorizationServers: ['https://auth.example.test'],
              verifyAccessToken: (token) => ({
                tokenType: 'access_token',
                subject: token,
                issuer: 'https://auth.example.test',
                audience: 'https://api.example.test/mcp',
                expiresAt: Math.floor(Date.now() / 1000) + 60,
                scopes: []
              })
            },
            skills: { authorization: { requiredScopes: ['skills:read'] } }
          }
        })
      )
      .mcpSkill('skill://protected/SKILL.md', skill('protected'))

    const get = await modernRpc(
      app,
      'skills/get',
      { uri: 'skill://protected/SKILL.md' },
      { authorization: 'Bearer limited' }
    )
    expect(get.status).toBe(403)
    const read = await modernRpc(
      app,
      'resources/read',
      { uri: 'skill://protected/SKILL.md' },
      { authorization: 'Bearer limited' }
    )
    expect(read.status).toBe(403)
  })

  test('keeps skill bytes authoritative when generic resources share their URI', async () => {
    const app = new Elysia()
      .use(mcp({ allowedRoutes: [] }))
      .mcpResource('skill://collision/SKILL.md', () => 'generic bytes')
      .mcpSkill('skill://collision/SKILL.md', skill('collision'))
    const read = await modernRpc(app, 'resources/read', {
      uri: 'skill://collision/SKILL.md'
    })
    expect(read.body.result.contents[0].text).toBe(skill('collision'))

    const provider: McpSkillProvider = {
      list: () => ({ skills: [] }),
      get: (uri) =>
        uri === 'skill://provided/SKILL.md'
          ? { uri, skill: skill('provided'), resources: {} }
          : null,
      read: () => 'wrong provider bytes'
    }
    const provided = new Elysia()
      .use(mcp({ allowedRoutes: [], extensions: { skills: { provider } } }))
      .mcpResource('skill://provided/SKILL.md', () => 'generic bytes')
    const providerRead = await modernRpc(provided, 'resources/read', {
      uri: 'skill://provided/SKILL.md'
    })
    expect(providerRead.body.result.contents[0].text).toBe(skill('provided'))
  })

  test('rejects provider manifests that conflict with static ownership', async () => {
    const nested = skill('nested')
    const providerSource = {
      uri: 'skill://outer/nested/SKILL.md',
      skill: `${nested}\nprovider-change`
    }
    const provider: McpSkillProvider = {
      list: () => ({
        skills: [providerSource]
      }),
      get: (uri) => (uri === providerSource.uri ? providerSource : null),
      read: () => null
    }
    const app = new Elysia()
      .use(mcp({ allowedRoutes: [], extensions: { skills: { provider } } }))
      .mcpSkill('skill://outer/SKILL.md', skill('outer'), {
        resources: { 'nested/SKILL.md': nested }
      })
    const listed = await modernRpc(app, 'skills/list')
    expect(listed.body.error.code).toBe(-32603)
    expect(listed.body.error.message).toContain('invalid skill')
    const direct = await modernRpc(app, 'skills/get', { uri: providerSource.uri })
    expect(direct.body.error.code).toBe(-32603)
    expect(direct.body.error.message).toContain('invalid skill')
  })

  test('rejects conflicting nested ownership across provider pages and direct reads', async () => {
    const nested = skill('nested')
    const outer = {
      uri: 'skill://provider-outer/SKILL.md',
      skill: skill('provider-outer'),
      resources: { 'nested/SKILL.md': nested }
    }
    const sources = new Map<string, McpSkillSource>([
      ['skill://provider-outer/SKILL.md', outer],
      [
        'skill://provider-outer/nested/SKILL.md',
        {
          uri: 'skill://provider-outer/nested/SKILL.md',
          skill: `${nested}\nchanged by nested publication`
        }
      ]
    ])
    const provider: McpSkillProvider = {
      list: ({ offset }) => ({
        skills: offset === 0 ? [outer] : [],
        hasMore: offset === 0
      }),
      get: (uri) => sources.get(uri) ?? null,
      read: () => null
    }
    const app = new Elysia().use(
      mcp({
        allowedRoutes: [],
        extensions: { skills: { provider, pagination: { pageSize: 1, signingKey } } }
      })
    )

    const direct = await modernRpc(app, 'skills/get', {
      uri: 'skill://provider-outer/nested/SKILL.md'
    })
    expect(direct.body.error.code).toBe(-32603)
    const read = await modernRpc(app, 'resources/read', {
      uri: 'skill://provider-outer/nested/SKILL.md'
    })
    expect(read.body.error.code).toBe(-32603)
  })

  test('rejects malformed target headers and unknown directory/file reads', async () => {
    const app = new Elysia()
      .use(mcp({ allowedRoutes: [], extensions: { skills: { directoryRead: true } } }))
      .mcpSkill('skill://safe/SKILL.md', skill('safe'))
    const mismatch = await modernRpc(
      app,
      'skills/get',
      { uri: 'skill://safe/SKILL.md' },
      { 'mcp-name': 'skill://other/SKILL.md' }
    )
    expect(mismatch.body.error.code).toBe(-32020)
    const traversal = await modernRpc(app, 'resources/read', {
      uri: 'skill://safe/%2e%2e/private.txt'
    })
    expect(traversal.body.error.code).toBe(-32602)
    const missingDirectory = await modernRpc(app, 'resources/directory/read', {
      uri: 'skill://safe/missing'
    })
    expect(missingDirectory.body.error.code).toBe(-32602)
  })
})
