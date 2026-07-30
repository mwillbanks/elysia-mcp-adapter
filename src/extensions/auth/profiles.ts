import {
  MCP_CLIENT_CREDENTIALS_EXTENSION,
  MCP_ENTERPRISE_MANAGED_AUTH_EXTENSION
} from './constants.js'
import type { McpAuthExtensionCapabilities, McpAuthProfileOptions } from './types.js'
import { resolveAuthVersion } from './version.js'

/**
 * Creates the `capabilities.extensions` fragment for the explicitly enabled
 * authorization profiles. Both extensions are opt-in.
 */
export function authProfileCapabilities(
  profiles: McpAuthProfileOptions = {}
): McpAuthExtensionCapabilities {
  const capabilities: McpAuthExtensionCapabilities = {}

  if (profiles.clientCredentials) {
    if (typeof profiles.clientCredentials === 'object') {
      resolveAuthVersion('client-credentials', profiles.clientCredentials.version)
    }
    capabilities[MCP_CLIENT_CREDENTIALS_EXTENSION] = {}
  }
  if (profiles.enterpriseManaged) {
    if (typeof profiles.enterpriseManaged === 'object') {
      resolveAuthVersion('enterprise-managed', profiles.enterpriseManaged.version)
    }
    capabilities[MCP_ENTERPRISE_MANAGED_AUTH_EXTENSION] = {}
  }

  return capabilities
}
