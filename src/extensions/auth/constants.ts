export const MCP_CORE_AUTH_CURRENT_VERSION = '2026-07-28' as const
export const MCP_ENTERPRISE_AUTH_CURRENT_VERSION = '2026-06-17' as const
export const MCP_CLIENT_CREDENTIALS_CURRENT_VERSION = 'draft' as const

export const MCP_CLIENT_CREDENTIALS_EXTENSION =
  'io.modelcontextprotocol/oauth-client-credentials' as const
export const MCP_ENTERPRISE_MANAGED_AUTH_EXTENSION =
  'io.modelcontextprotocol/enterprise-managed-authorization' as const

export const MCP_ENTERPRISE_GRANT_PROFILE = 'urn:ietf:params:oauth:grant-profile:id-jag' as const

export const MCP_AUTH_VERSION_MANIFEST = {
  core: {
    current: MCP_CORE_AUTH_CURRENT_VERSION,
    supported: ['draft', MCP_CORE_AUTH_CURRENT_VERSION, '2025-11-25', '2025-06-18']
  },
  'client-credentials': {
    current: MCP_CLIENT_CREDENTIALS_CURRENT_VERSION,
    supported: [MCP_CLIENT_CREDENTIALS_CURRENT_VERSION]
  },
  'enterprise-managed': {
    current: MCP_ENTERPRISE_AUTH_CURRENT_VERSION,
    supported: [MCP_ENTERPRISE_AUTH_CURRENT_VERSION]
  }
} as const
