import type { McpProtocolVersion } from '../extensions/manifest.js'
import { isRecord } from '../internal.js'
import type { JsonRpcRequest, McpClientInfo, NormalizedMcpPluginOptions } from '../types.js'
import { assertClientCapabilities, assertClientInfo } from './capability-validation.js'
import { McpProtocolError } from './protocol-error.js'
import { requestTargetName } from './protocol-routing.js'

export { McpProtocolError } from './protocol-error.js'

const MODERN_PROTOCOL_VERSION = '2026-07-28' as const
const LEGACY_PROTOCOL_VERSION = '2025-11-25' as const
const PROTOCOL_VERSION_META_KEY = 'io.modelcontextprotocol/protocolVersion'
const CLIENT_CAPABILITIES_META_KEY = 'io.modelcontextprotocol/clientCapabilities'
const CLIENT_INFO_META_KEY = 'io.modelcontextprotocol/clientInfo'
const BASE64_SENTINEL = /^=\?base64\?([A-Za-z0-9+/]*={0,2})\?=$/u

export interface McpRequestProtocolContext {
  version: McpProtocolVersion
  modern: boolean
  clientCapabilities: Record<string, unknown>
  clientInfo?: McpClientInfo
  meta?: Record<string, unknown>
}

export function resolveRequestProtocol(
  request: Request,
  payload: JsonRpcRequest,
  options: NormalizedMcpPluginOptions
): McpRequestProtocolContext {
  const meta = isRecord(payload.params?._meta) ? payload.params._meta : undefined
  const headerVersion = request.headers.get('mcp-protocol-version')
  const metaVersion = meta?.[PROTOCOL_VERSION_META_KEY]
  assertProtocolVersionEnvelope(headerVersion, metaVersion)
  const requestedVersion =
    typeof metaVersion === 'string'
      ? metaVersion
      : (headerVersion ?? options.transport.protocolVersions[0] ?? LEGACY_PROTOCOL_VERSION)

  if (!isSupportedProtocolVersion(requestedVersion, options)) {
    throw new McpProtocolError(-32022, `Unsupported protocol version: ${requestedVersion}`, 400, {
      supported: options.transport.protocolVersions,
      requested: requestedVersion
    })
  }

  const modern = requestedVersion === MODERN_PROTOCOL_VERSION
  if (!modern) {
    return {
      version: LEGACY_PROTOCOL_VERSION,
      modern: false,
      clientCapabilities: {},
      meta
    }
  }

  if (headerVersion !== MODERN_PROTOCOL_VERSION || metaVersion !== MODERN_PROTOCOL_VERSION) {
    throw new McpProtocolError(
      -32020,
      'Modern MCP requests require matching protocol versions in the header and request _meta',
      400
    )
  }

  assertRoutingHeaders(request, payload)
  assertAcceptHeader(request)
  assertProgressToken(meta?.progressToken)

  const capabilities = meta?.[CLIENT_CAPABILITIES_META_KEY]
  const clientInfo = meta?.[CLIENT_INFO_META_KEY]
  assertClientCapabilities(capabilities)
  if (clientInfo !== undefined) assertClientInfo(clientInfo)
  return {
    version: MODERN_PROTOCOL_VERSION,
    modern: true,
    clientCapabilities: capabilities,
    clientInfo,
    meta
  }
}

function assertProgressToken(value: unknown): void {
  if (
    value === undefined ||
    typeof value === 'string' ||
    (typeof value === 'number' && Number.isSafeInteger(value))
  ) {
    return
  }
  throw new McpProtocolError(-32020, 'progressToken must be a string or integer', 400)
}

function assertAcceptHeader(request: Request): void {
  const accept = request.headers.get('accept')?.toLowerCase() ?? ''
  if (accept.includes('application/json') && accept.includes('text/event-stream')) return
  throw new McpProtocolError(
    -32020,
    'Modern MCP requests must accept application/json and text/event-stream',
    400
  )
}

function assertProtocolVersionEnvelope(headerVersion: string | null, metaVersion: unknown): void {
  const modernEnvelope =
    headerVersion === MODERN_PROTOCOL_VERSION || metaVersion === MODERN_PROTOCOL_VERSION
  const versionsDiffer =
    headerVersion !== null && metaVersion !== undefined && headerVersion !== metaVersion
  const modernVersionMissing =
    modernEnvelope &&
    (headerVersion !== MODERN_PROTOCOL_VERSION || metaVersion !== MODERN_PROTOCOL_VERSION)
  if (!versionsDiffer && !modernVersionMissing) return
  throw new McpProtocolError(
    -32020,
    'MCP-Protocol-Version header and request _meta must match',
    400
  )
}

function assertRoutingHeaders(request: Request, payload: JsonRpcRequest): void {
  if (request.headers.get('mcp-method') !== payload.method) {
    throw new McpProtocolError(-32020, 'Mcp-Method header must match the JSON-RPC method', 400)
  }

  const expectedName = requestTargetName(payload)
  const headerName = request.headers.get('mcp-name')
  const decodedName = headerName === null ? null : decodeMcpHeaderValue(headerName, 'Mcp-Name')
  if (expectedName !== undefined && decodedName !== expectedName) {
    throw new McpProtocolError(-32020, 'Mcp-Name header must match the request target', 400)
  }
  if (expectedName === undefined && headerName !== null) {
    throw new McpProtocolError(-32020, 'Mcp-Name is not valid for this method', 400)
  }
}

function isSupportedProtocolVersion(
  version: string,
  options: NormalizedMcpPluginOptions
): version is McpProtocolVersion {
  return options.transport.protocolVersions.includes(version as McpProtocolVersion)
}

export function serverDiscoverResult(options: NormalizedMcpPluginOptions) {
  return {
    resultType: 'complete',
    supportedVersions: options.transport.protocolVersions,
    _meta: {
      'io.modelcontextprotocol/serverInfo': {
        name: options.server.name,
        version: options.server.version,
        title: options.server.title
      }
    },
    instructions: options.server.instructions
  }
}

export function decodeMcpHeaderValue(value: string, headerName: string): string {
  if (
    Array.from(value).some((character) => {
      const code = character.charCodeAt(0)
      return (code < 0x20 && code !== 0x09) || code === 0x7f
    })
  ) {
    throw new McpProtocolError(-32020, `${headerName} contains invalid characters`, 400)
  }
  if (!(value.startsWith('=?base64?') && value.endsWith('?='))) return value

  const match = BASE64_SENTINEL.exec(value)
  if (!match) {
    throw new McpProtocolError(-32020, `${headerName} contains malformed base64`, 400)
  }
  const encoded = match[1] ?? ''
  if (encoded.length % 4 !== 0) {
    throw new McpProtocolError(-32020, `${headerName} contains malformed base64`, 400)
  }
  const decoded = Buffer.from(encoded, 'base64')
  if (decoded.toString('base64') !== encoded) {
    throw new McpProtocolError(-32020, `${headerName} contains malformed base64`, 400)
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(decoded)
  } catch {
    throw new McpProtocolError(-32020, `${headerName} contains malformed base64`, 400)
  }
}
