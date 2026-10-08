import { createHash } from 'node:crypto'
import type { Elysia } from 'elysia'

async function rpc(app: Elysia, method: string, params: Record<string, unknown> = {}) {
  const uri = typeof params.uri === 'string' ? params.uri : undefined
  const response = await app.handle(
    new Request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2026-07-28',
        'mcp-method': method,
        ...(uri ? { 'mcp-name': uri } : {})
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method,
        params: {
          ...params,
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientInfo': {
              name: 'skills-example-client',
              version: '1.0.0'
            },
            'io.modelcontextprotocol/clientCapabilities': {}
          }
        }
      })
    })
  )
  return (await response.json()) as any
}

export async function verifyPublishedSkill(app: Elysia): Promise<void> {
  await verifyCapabilities(app)
  const entries = await collectSkills(app)
  let verifiedEmptyResource = false
  for (const entry of entries) {
    if (!Array.isArray(entry.resources)) throw new Error('Example requires static manifests')
    for (const resource of entry.resources) {
      const size = await verifyResource(app, resource)
      if (resource.uri.endsWith('/EMPTY.txt') && size === 0) verifiedEmptyResource = true
    }
  }
  if (!verifiedEmptyResource)
    throw new Error('Empty text resource integrity verification was not exercised')
  await verifyDirectLookup(app)
}

async function verifyCapabilities(app: Elysia): Promise<void> {
  const discovery = await rpc(app, 'server/discover')
  const skillsCapability =
    discovery.result.capabilities.extensions?.['io.modelcontextprotocol/skills']
  if (!skillsCapability || !discovery.result.capabilities.resources) {
    throw new Error('Server did not advertise Skills and Resources capabilities')
  }
}

interface ManifestResource {
  uri: string
  size: number
  digest: string
}
interface SkillEntry {
  resources?: ManifestResource[]
}

async function collectSkills(app: Elysia): Promise<SkillEntry[]> {
  const entries: SkillEntry[] = []
  let cursor: string | undefined
  let pages = 0
  do {
    const listed = await rpc(app, 'skills/list', cursor ? { cursor } : {})
    entries.push(...listed.result.skills)
    cursor = listed.result.nextCursor
    pages += 1
  } while (cursor)
  if (pages < 2) throw new Error('Skills pagination was not exercised')
  return entries
}

async function verifyResource(app: Elysia, resource: ManifestResource): Promise<number> {
  const read = await rpc(app, 'resources/read', { uri: resource.uri })
  const content = read.result.contents[0]
  const bytes =
    typeof content.text === 'string'
      ? new TextEncoder().encode(content.text)
      : Uint8Array.from(Buffer.from(content.blob, 'base64'))
  const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`
  if (bytes.byteLength !== resource.size || digest !== resource.digest) {
    throw new Error(`Integrity verification failed for ${resource.uri}`)
  }
  return bytes.byteLength
}

async function verifyDirectLookup(app: Elysia): Promise<void> {
  const direct = await rpc(app, 'skills/get', { uri: 'skill://direct-lookup/SKILL.md' })
  if (direct.result.skill.frontmatter.name !== 'direct-lookup') {
    throw new Error('Direct skill lookup failed')
  }
}
