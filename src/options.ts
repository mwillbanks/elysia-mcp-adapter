import {
  DEFAULT_ALLOW_TOOL_INPUT_HEADERS,
  DEFAULT_ALLOWED_ROUTES,
  DEFAULT_EXCLUDED_ROUTES,
  DEFAULT_HTTP_METHODS,
  DEFAULT_MARSHAL,
  DEFAULT_MCP_PATH,
  DEFAULT_PASS_THROUGH_HEADERS,
  DEFAULT_PROTOCOL_VERSION
} from './constants.js'
import { defaultOperationNameResolver } from './naming.js'
import type { McpPluginOptions, NormalizedMcpPluginOptions } from './types.js'

export function normalizeOptions(options: McpPluginOptions = {}): NormalizedMcpPluginOptions {
  return {
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
    diagnostics: {
      failOnMissingSchema: options.diagnostics?.failOnMissingSchema ?? false
    },
    mapJsonSchema: options.mapJsonSchema
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

function normalizeTransport(options: McpPluginOptions): NormalizedMcpPluginOptions['transport'] {
  return {
    validateOrigin: options.transport?.validateOrigin ?? true,
    allowedOrigins: options.transport?.allowedOrigins ?? [],
    enableGetSse: options.transport?.enableGetSse ?? false,
    enableDeleteSession: options.transport?.enableDeleteSession ?? false,
    protocolVersion: options.transport?.protocolVersion ?? DEFAULT_PROTOCOL_VERSION
  }
}

function normalizeEndpointPath(path: string): string {
  if (!path.startsWith('/')) return `/${path}`
  return path
}

function normalizeHeaderNames(headers: string[]): string[] {
  return Array.from(new Set(headers.map((header) => header.trim().toLowerCase()).filter(Boolean)))
}
