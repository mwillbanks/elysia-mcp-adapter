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
import { resolveAuthVersion } from './extensions/auth/index.js'
import { MCP_EXTENSION_SUPPORT, resolvePinnedVersion } from './extensions/manifest.js'
import { resolveTasksVersion } from './extensions/tasks/index.js'
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
    extensions: normalizeExtensions(options),
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
  const legacyProtocolVersion = options.transport?.protocolVersion ?? DEFAULT_PROTOCOL_VERSION
  if (legacyProtocolVersion !== DEFAULT_PROTOCOL_VERSION) {
    throw new TypeError(
      `transport.protocolVersion is reserved for legacy initialize and must be "${DEFAULT_PROTOCOL_VERSION}"; configure modern support with transport.protocolVersions`
    )
  }

  const protocolVersions = options.transport?.protocolVersions ?? [
    ...MCP_EXTENSION_SUPPORT.protocol.supported
  ]
  for (const version of protocolVersions) {
    if (!MCP_EXTENSION_SUPPORT.protocol.supported.includes(version)) {
      throw new TypeError(
        `Unsupported MCP protocol version "${version}". Supported versions: ${MCP_EXTENSION_SUPPORT.protocol.supported.join(', ')}`
      )
    }
  }

  return {
    validateOrigin: options.transport?.validateOrigin ?? true,
    allowedOrigins: options.transport?.allowedOrigins ?? [],
    enableGetSse: options.transport?.enableGetSse ?? false,
    enableDeleteSession: options.transport?.enableDeleteSession ?? false,
    protocolVersion: legacyProtocolVersion,
    protocolVersions
  }
}

function normalizeExtensions(options: McpPluginOptions): NormalizedMcpPluginOptions['extensions'] {
  const tasks = options.extensions?.tasks
  const auth = options.extensions?.auth
  const apps = options.extensions?.apps

  if (tasks?.defaultTtl !== undefined && tasks.defaultTtl !== null && tasks.defaultTtl <= 0) {
    throw new TypeError('Tasks defaultTtl must be a positive number of milliseconds or null')
  }
  if (tasks?.pollInterval !== undefined && tasks.pollInterval <= 0) {
    throw new TypeError('Tasks pollInterval must be a positive number of milliseconds')
  }

  return {
    tasks: tasks
      ? {
          ...tasks,
          version: resolveTasksVersion(tasks.version)
        }
      : undefined,
    auth: auth
      ? {
          ...auth,
          profiles: {
            clientCredentials:
              auth.profiles?.clientCredentials === true
                ? true
                : auth.profiles?.clientCredentials
                  ? {
                      version: resolveAuthVersion(
                        'client-credentials',
                        auth.profiles.clientCredentials.version
                      ) as 'draft'
                    }
                  : undefined,
            enterpriseManaged:
              auth.profiles?.enterpriseManaged === true
                ? true
                : auth.profiles?.enterpriseManaged
                  ? {
                      version: resolveAuthVersion(
                        'enterprise-managed',
                        auth.profiles.enterpriseManaged.version
                      ) as '2026-06-17'
                    }
                  : undefined
          },
          version: resolveAuthVersion('core', auth.version) as Exclude<
            NonNullable<typeof auth.version>,
            'current'
          >
        }
      : undefined,
    apps: apps
      ? {
          ...apps,
          version: resolvePinnedVersion(
            'apps',
            apps.version,
            MCP_EXTENSION_SUPPORT.apps.current,
            MCP_EXTENSION_SUPPORT.apps.versions
          )
        }
      : undefined
  }
}

function normalizeEndpointPath(path: string): string {
  if (!path.startsWith('/')) return `/${path}`
  return path
}

function normalizeHeaderNames(headers: string[]): string[] {
  return Array.from(new Set(headers.map((header) => header.trim().toLowerCase()).filter(Boolean)))
}
