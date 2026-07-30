import type { McpProtocolVersion } from '../extensions/manifest.js'
import { isRecord } from '../internal.js'
import type { JsonRpcRequest, NormalizedMcpPluginOptions } from '../types.js'

const MODERN_PROTOCOL_VERSION = '2026-07-28' as const
const LEGACY_PROTOCOL_VERSION = '2025-11-25' as const
const PROTOCOL_VERSION_META_KEY = 'io.modelcontextprotocol/protocolVersion'
const CLIENT_CAPABILITIES_META_KEY = 'io.modelcontextprotocol/clientCapabilities'
const BASE64_SENTINEL = /^=\?base64\?([A-Za-z0-9+/]*={0,2})\?=$/u

export interface McpRequestProtocolContext {
  version: McpProtocolVersion
  modern: boolean
  clientCapabilities: Record<string, unknown>
  meta?: Record<string, unknown>
}

export class McpProtocolError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly status = 400,
    readonly data?: unknown
  ) {
    super(message)
  }
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
    typeof metaVersion === 'string' ? metaVersion : (headerVersion ?? LEGACY_PROTOCOL_VERSION)

  if (!isSupportedProtocolVersion(requestedVersion, options)) {
    throw new McpProtocolError(-32022, `Unsupported protocol version: ${requestedVersion}`, 400, {
      supportedVersions: options.transport.protocolVersions
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

  assertRoutingHeaders(request, payload)

  const capabilities = meta?.[CLIENT_CAPABILITIES_META_KEY]
  assertClientCapabilities(capabilities)
  return {
    version: MODERN_PROTOCOL_VERSION,
    modern: true,
    clientCapabilities: capabilities,
    meta
  }
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

  const expectedName = methodName(payload)
  const headerName = request.headers.get('mcp-name')
  const decodedName = headerName === null ? null : decodeMcpHeaderValue(headerName, 'Mcp-Name')
  if (expectedName !== undefined && decodedName !== expectedName) {
    throw new McpProtocolError(-32020, 'Mcp-Name header must match the request target', 400)
  }
  if (expectedName === undefined && headerName !== null) {
    throw new McpProtocolError(-32020, 'Mcp-Name is not valid for this method', 400)
  }
}

function assertClientCapabilities(value: unknown): asserts value is Record<string, unknown> {
  if (isRecord(value)) return
  throw new McpProtocolError(
    -32020,
    'Modern MCP requests require client capabilities in request _meta',
    400
  )
}

function isSupportedProtocolVersion(
  version: string,
  options: NormalizedMcpPluginOptions
): version is McpProtocolVersion {
  return options.transport.protocolVersions.includes(version as McpProtocolVersion)
}

function protocolCapabilities(options: NormalizedMcpPluginOptions) {
  const extensions: Record<string, unknown> = {}
  if (options.extensions.tasks) {
    extensions.tasks = { version: options.extensions.tasks.version }
  }
  if (options.extensions.auth) {
    extensions.auth = { version: options.extensions.auth.version }
  }
  if (options.extensions.apps) {
    extensions.apps = { version: options.extensions.apps.version }
  }

  return {
    tools: { listChanged: false },
    resources: { subscribe: false, listChanged: false },
    prompts: { listChanged: false },
    extensions
  }
}

export function serverDiscoverResult(options: NormalizedMcpPluginOptions) {
  return {
    cacheScope: 'private',
    resultType: 'complete',
    supportedVersions: options.transport.protocolVersions,
    ttlMs: 0,
    capabilities: protocolCapabilities(options),
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

function methodName(payload: JsonRpcRequest): string | undefined {
  const params = isRecord(payload.params) ? payload.params : {}
  if (payload.method === 'tools/call' || payload.method === 'prompts/get') {
    return typeof params.name === 'string' ? params.name : undefined
  }
  if (payload.method === 'resources/read') {
    return typeof params.uri === 'string' ? params.uri : undefined
  }
  return undefined
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
  if (!value.startsWith('=?base64?') && !value.endsWith('?=')) return value

  const match = BASE64_SENTINEL.exec(value)
  if (!match) {
    throw new McpProtocolError(-32020, `${headerName} contains malformed base64`, 400)
  }
  const encoded = match[1] ?? ''
  if (encoded.length % 4 !== 0) {
    throw new McpProtocolError(-32020, `${headerName} contains malformed base64`, 400)
  }
  const decoded = Buffer.from(encoded, 'base64')
  if (decoded.toString('base64') !== encoded || decoded.toString('utf8').includes('\uFFFD')) {
    throw new McpProtocolError(-32020, `${headerName} contains malformed base64`, 400)
  }
  return decoded.toString('utf8')
}
