import { MCP_AUTH_VERSION_MANIFEST } from './constants.js'
import type { McpAuthProfile, McpAuthVersion } from './types.js'

/**
 * Resolves the moving `current` alias independently for each authorization
 * profile and rejects revisions that the adapter does not implement.
 */
export function resolveAuthVersion(
  profile: McpAuthProfile,
  version: McpAuthVersion = 'current'
): string {
  const manifest = MCP_AUTH_VERSION_MANIFEST[profile]
  const resolved = version === 'current' ? manifest.current : version
  const supported: readonly string[] = manifest.supported

  if (!supported.includes(resolved)) {
    throw new RangeError(
      `Unsupported ${profile} authorization version "${version}". Supported versions: ${supported.join(', ')}`
    )
  }

  return resolved
}
