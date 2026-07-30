import { MCP_EXTENSION_SUPPORT, type McpProtocolVersion } from '../extensions/manifest.js'
import { isRecord } from '../internal.js'
import type { JsonRpcRequest, NormalizedMcpPluginOptions } from '../types.js'

const MODERN_PROTOCOL_VERSION = '2026-07-28' as const
const LEGACY_PROTOCOL_VERSION = '2025-11-25' as const
const PROTOCOL_VERSION_META_KEY = 'io.modelcontextprotocol/protocolVersion'
const CLIENT_CAPABILITIES_META_KEY = 'io.modelcontextprotocol/clientCapabilities'

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

  if (headerVersion !== requestedVersion || metaVersion !== requestedVersion) {
    throw new McpProtocolError(
      -32020,
      'MCP-Protocol-Version header and request _meta must match',
      400
    )
  }

  const headerMethod = request.headers.get('mcp-method')
  if (headerMethod !== payload.method) {
    throw new McpProtocolError(-32020, 'Mcp-Method header must match the JSON-RPC method', 400)
  }

  const expectedName = methodName(payload)
  const headerName = request.headers.get('mcp-name')
  if (expectedName !== undefined && headerName !== expectedName) {
    throw new McpProtocolError(-32020, 'Mcp-Name header must match the request target', 400)
  }
  if (expectedName === undefined && headerName !== null) {
    throw new McpProtocolError(-32020, 'Mcp-Name is not valid for this method', 400)
  }

  const capabilities = meta?.[CLIENT_CAPABILITIES_META_KEY]
  return {
    version: MODERN_PROTOCOL_VERSION,
    modern: true,
    clientCapabilities: isRecord(capabilities) ? capabilities : {},
    meta
  }
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
    resultType: 'complete',
    protocolVersions: options.transport.protocolVersions,
    currentProtocolVersion: MCP_EXTENSION_SUPPORT.protocol.current,
    capabilities: protocolCapabilities(options),
    serverInfo: {
      name: options.server.name,
      version: options.server.version,
      title: options.server.title
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
  if (payload.method?.startsWith('tasks/')) {
    return typeof params.taskId === 'string' ? params.taskId : undefined
  }
  return undefined
}
