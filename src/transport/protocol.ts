import type { McpProtocolVersion } from '../extensions/manifest.js'
import { isRecord } from '../internal.js'
import { isValidUri } from '../schema/validate.js'
import type { JsonRpcRequest, McpClientInfo, NormalizedMcpPluginOptions } from '../types.js'

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

function assertClientInfo(value: unknown): asserts value is McpClientInfo {
  if (
    isRecord(value) &&
    typeof value.name === 'string' &&
    value.name.length > 0 &&
    typeof value.version === 'string' &&
    value.version.length > 0 &&
    (value.title === undefined || typeof value.title === 'string') &&
    (value.description === undefined || typeof value.description === 'string') &&
    (value.websiteUrl === undefined || isValidUri(value.websiteUrl)) &&
    (value.icons === undefined || (Array.isArray(value.icons) && value.icons.every(isIcon)))
  ) {
    return
  }
  throw new McpProtocolError(-32020, 'clientInfo must match the MCP implementation schema', 400)
}

function isIcon(value: unknown): boolean {
  return (
    isRecord(value) &&
    isValidUri(value.src) &&
    (value.mimeType === undefined || typeof value.mimeType === 'string') &&
    (value.sizes === undefined ||
      (Array.isArray(value.sizes) && value.sizes.every((size) => typeof size === 'string'))) &&
    (value.theme === undefined || value.theme === 'dark' || value.theme === 'light')
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
  if (!isRecord(value)) {
    throw new McpProtocolError(
      -32020,
      'Modern MCP requests require client capabilities in request _meta',
      400
    )
  }
  for (const capability of ['elicitation', 'roots', 'sampling']) {
    if (value[capability] !== undefined && !isRecord(value[capability])) {
      throw new McpProtocolError(-32020, `clientCapabilities.${capability} must be an object`, 400)
    }
  }
  const elicitation = value.elicitation
  if (isRecord(elicitation)) {
    for (const mode of ['form', 'url']) {
      if (elicitation[mode] !== undefined && !isRecord(elicitation[mode])) {
        throw new McpProtocolError(
          -32020,
          `clientCapabilities.elicitation.${mode} must be an object`,
          400
        )
      }
    }
  }
  const sampling = value.sampling
  if (isRecord(sampling)) {
    for (const feature of ['context', 'tools']) {
      if (sampling[feature] !== undefined && !isRecord(sampling[feature])) {
        throw new McpProtocolError(
          -32020,
          `clientCapabilities.sampling.${feature} must be an object`,
          400
        )
      }
    }
  }
  const roots = value.roots
  if (
    isRecord(roots) &&
    roots.listChanged !== undefined &&
    typeof roots.listChanged !== 'boolean'
  ) {
    throw new McpProtocolError(-32020, 'clientCapabilities.roots.listChanged must be boolean', 400)
  }
  for (const namespace of ['experimental', 'extensions']) {
    const container = value[namespace]
    if (container === undefined) continue
    if (!isRecord(container) || Object.values(container).some((entry) => !isRecord(entry))) {
      throw new McpProtocolError(-32020, `clientCapabilities.${namespace} must map to objects`, 400)
    }
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

function methodName(payload: JsonRpcRequest): string | undefined {
  const params = isRecord(payload.params) ? payload.params : {}
  if (payload.method === 'tools/call' || payload.method === 'prompts/get') {
    return typeof params.name === 'string' ? params.name : undefined
  }
  if (
    payload.method === 'resources/read' ||
    payload.method === 'resources/directory/read' ||
    payload.method === 'skills/get'
  ) {
    return typeof params.uri === 'string' ? params.uri : undefined
  }
  if (
    payload.method === 'tasks/get' ||
    payload.method === 'tasks/update' ||
    payload.method === 'tasks/cancel'
  ) {
    return typeof params.taskId === 'string' ? params.taskId : undefined
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
