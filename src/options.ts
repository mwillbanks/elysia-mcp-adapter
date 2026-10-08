import {
  DEFAULT_ALLOW_TOOL_INPUT_HEADERS,
  DEFAULT_ALLOWED_ROUTES,
  DEFAULT_EXCLUDED_ROUTES,
  DEFAULT_HTTP_METHODS,
  DEFAULT_MARSHAL,
  DEFAULT_MCP_PATH,
  DEFAULT_PASS_THROUGH_HEADERS,
  LEGACY_PROTOCOL_VERSION
} from './constants.js'
import { defaultOperationNameResolver } from './naming.js'
import { normalizeCore } from './options/core.js'
import { normalizeExtensions } from './options/extensions.js'
import { normalizeTransport } from './options/transport.js'
import type { McpPluginOptions, NormalizedMcpPluginOptions } from './types.js'

function normalizeHeaderNames(headers: string[]): string[] {
  return Array.from(new Set(headers.map((header) => header.trim().toLowerCase()).filter(Boolean)))
}

function normalizeHeaders(options: McpPluginOptions): NormalizedMcpPluginOptions['headers'] {
  return {
    allowFromToolInput: normalizeHeaderNames(
      options.headers?.allowFromToolInput ?? DEFAULT_ALLOW_TOOL_INPUT_HEADERS
    ),
    passThroughFromMcpRequest: normalizeHeaderNames(
      options.headers?.passThroughFromMcpRequest ?? DEFAULT_PASS_THROUGH_HEADERS
    )
  }
}

function normalizeServer(options: McpPluginOptions): NormalizedMcpPluginOptions['server'] {
  return {
    name: options.server?.name ?? 'elysia-mcp-adapter',
    version: options.server?.version ?? '0.1.0',
    title: options.server?.title,
    instructions: options.server?.instructions
  }
}

function normalizeEndpointPath(path: string): string {
  return path.startsWith('/') ? path : `/${path}`
}

function assertLegacyExtensions(normalized: NormalizedMcpPluginOptions): void {
  const legacyOnly =
    normalized.transport.protocolVersions.length === 1 &&
    normalized.transport.protocolVersions[0] === LEGACY_PROTOCOL_VERSION
  if (normalized.extensions.variants && !legacyOnly) {
    throw new TypeError('Server variants require legacy-only protocol configuration')
  }
  if (normalized.extensions.events && !legacyOnly) {
    throw new TypeError('Events require legacy-only protocol configuration')
  }
}

export function normalizeOptions(options: McpPluginOptions = {}): NormalizedMcpPluginOptions {
  const normalized = {
    server: normalizeServer(options),
    path: normalizeEndpointPath(options.path ?? DEFAULT_MCP_PATH),
    allowedRoutes: options.allowedRoutes ?? DEFAULT_ALLOWED_ROUTES,
    excludedRoutes: [...DEFAULT_EXCLUDED_ROUTES, ...(options.excludedRoutes ?? [])],
    methods: options.methods ?? DEFAULT_HTTP_METHODS,
    operationNameResolver: options.operationNameResolver ?? defaultOperationNameResolver,
    defaultRouteKind: options.defaultRouteKind ?? 'tool',
    onNameCollision: options.onNameCollision ?? 'error',
    inputMode: options.inputMode ?? 'envelope',
    includeHiddenRoutes: options.includeHiddenRoutes ?? false,
    headers: normalizeHeaders(options),
    marshal: { ...DEFAULT_MARSHAL, ...(options.marshal ?? {}) },
    transport: normalizeTransport(options),
    core: normalizeCore(options),
    extensions: normalizeExtensions(options),
    diagnostics: { failOnMissingSchema: options.diagnostics?.failOnMissingSchema ?? false },
    mapJsonSchema: options.mapJsonSchema
  } satisfies NormalizedMcpPluginOptions
  assertLegacyExtensions(normalized)
  return normalized
}
