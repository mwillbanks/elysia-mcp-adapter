export const MCP_APPS_EXTENSION_ID = 'io.modelcontextprotocol/ui' as const

export const MCP_APPS_RESOURCE_URI_META_KEY = 'ui/resourceUri' as const

export const MCP_APPS_RESOURCE_MIME_TYPE = 'text/html;profile=mcp-app' as const

export const MCP_APPS_PROTOCOL_VERSION_2026_01_26 = '2026-01-26' as const

export const MCP_APPS_CURRENT_PROTOCOL_VERSION = MCP_APPS_PROTOCOL_VERSION_2026_01_26

export const MCP_APPS_DRAFT_PROTOCOL_VERSION = 'draft' as const

export const MCP_APPS_PROTOCOL_VERSIONS = [
  MCP_APPS_PROTOCOL_VERSION_2026_01_26,
  MCP_APPS_DRAFT_PROTOCOL_VERSION
] as const

export const MCP_APPS_PROTOCOL_VERSION_ALIASES = {
  current: MCP_APPS_CURRENT_PROTOCOL_VERSION,
  '2026-01-26': MCP_APPS_PROTOCOL_VERSION_2026_01_26,
  draft: MCP_APPS_DRAFT_PROTOCOL_VERSION
} as const

export type McpAppsProtocolVersion = (typeof MCP_APPS_PROTOCOL_VERSIONS)[number]
export type McpAppsProtocolVersionSelector = keyof typeof MCP_APPS_PROTOCOL_VERSION_ALIASES

export function resolveMcpAppsProtocolVersion(version: string = 'current'): McpAppsProtocolVersion {
  if (!(version in MCP_APPS_PROTOCOL_VERSION_ALIASES)) {
    throw new TypeError(`Unsupported MCP Apps protocol version: ${version}`)
  }

  return MCP_APPS_PROTOCOL_VERSION_ALIASES[version as McpAppsProtocolVersionSelector]
}
