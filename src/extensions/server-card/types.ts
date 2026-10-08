import type { McpIcon } from '../../types.js'

export const MCP_SERVER_CARD_ID = 'io.modelcontextprotocol/server-card' as const
export const MCP_SERVER_CARD_REVISION = '526201bbc80231daa40ffcdecfc9da4e54e5dc93' as const
export const MCP_SERVER_CARD_MIME_TYPE = 'application/mcp-server-card+json' as const
export const MCP_SERVER_CARD_SCHEMA =
  'https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json' as const

export interface McpServerCard {
  $schema: typeof MCP_SERVER_CARD_SCHEMA
  name: string
  description: string
  version: string
  title?: string
  websiteUrl?: string
  icons?: McpIcon[]
  remotes?: Array<{
    type: 'sse' | 'streamable-http'
    url: string
    supportedProtocolVersions?: string[]
    variables?: Record<string, Record<string, unknown>>
    headers?: Array<Record<string, unknown> & { name: string }>
  }>
  repository?: { source: string; url: string; id?: string; subfolder?: string }
  _meta?: Record<string, unknown>
}

export interface McpServerCardOptions {
  version?: 'current' | typeof MCP_SERVER_CARD_REVISION
  card: McpServerCard
  maxAgeSeconds?: number
  /** Production requires HTTPS. Development permits loopback HTTP only. */
  environment?: 'production' | 'development'
}
