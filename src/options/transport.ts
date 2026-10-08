import { LEGACY_PROTOCOL_VERSION } from '../constants.js'
import { MCP_EXTENSION_SUPPORT } from '../extensions/manifest.js'
import { assertAllowedOrigin } from '../transport/origin-policy.js'
import type { McpPluginOptions, NormalizedMcpPluginOptions } from '../types.js'

function validateLegacyVersion(version: string): void {
  if (version === LEGACY_PROTOCOL_VERSION) return
  throw new TypeError(
    `transport.protocolVersion is reserved for legacy initialize and must be "${LEGACY_PROTOCOL_VERSION}"; configure modern support with transport.protocolVersions`
  )
}

function validateProtocolVersions(versions: readonly string[]): void {
  for (const version of versions) {
    if (MCP_EXTENSION_SUPPORT.protocol.supported.some((supported) => supported === version))
      continue
    throw new TypeError(
      `Unsupported MCP protocol version "${version}". Supported versions: ${MCP_EXTENSION_SUPPORT.protocol.supported.join(', ')}`
    )
  }
}

export function normalizeTransport(
  options: McpPluginOptions
): NormalizedMcpPluginOptions['transport'] {
  const legacyProtocolVersion = options.transport?.protocolVersion ?? LEGACY_PROTOCOL_VERSION
  validateLegacyVersion(legacyProtocolVersion)
  const protocolVersions = options.transport?.protocolVersions ?? [
    ...MCP_EXTENSION_SUPPORT.protocol.supported
  ]
  validateProtocolVersions(protocolVersions)
  const allowedOrigins = options.transport?.allowedOrigins ?? []
  for (const origin of allowedOrigins) assertAllowedOrigin(origin)
  return {
    validateOrigin: options.transport?.validateOrigin ?? true,
    allowedOrigins,
    enableGetSse: options.transport?.enableGetSse ?? false,
    enableDeleteSession: options.transport?.enableDeleteSession ?? false,
    protocolVersion: legacyProtocolVersion,
    protocolVersions
  }
}
