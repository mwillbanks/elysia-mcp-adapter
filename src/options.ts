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
import { resolveAuthVersion } from './extensions/auth/index.js'
import { MCP_EVENTS_REVISION } from './extensions/events/index.js'
import { MCP_INTERCEPTORS_REVISION } from './extensions/interceptors/index.js'
import { MCP_EXTENSION_SUPPORT, resolvePinnedVersion } from './extensions/manifest.js'
import { normalizeServerCardOptions } from './extensions/server-card/index.js'
import { MCP_SKILLS_VERSION } from './extensions/skills/index.js'
import { resolveTasksVersion } from './extensions/tasks/index.js'
import {
  MCP_SERVER_VARIANTS_REVISION,
  type McpVariantsOptions
} from './extensions/variants/index.js'
import { defaultOperationNameResolver } from './naming.js'
import type { McpPluginOptions, NormalizedMcpPluginOptions } from './types.js'

const MAX_TIMER_DELAY_MS = 2_147_483_647

export function normalizeOptions(options: McpPluginOptions = {}): NormalizedMcpPluginOptions {
  const core = normalizeCore(options)
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
    core,
    extensions: normalizeExtensions(options),
    diagnostics: {
      failOnMissingSchema: options.diagnostics?.failOnMissingSchema ?? false
    },
    mapJsonSchema: options.mapJsonSchema
  } satisfies NormalizedMcpPluginOptions
  if (
    normalized.extensions.variants &&
    (normalized.transport.protocolVersions.length !== 1 ||
      normalized.transport.protocolVersions[0] !== LEGACY_PROTOCOL_VERSION)
  ) {
    throw new TypeError('Server variants require legacy-only protocol configuration')
  }
  if (
    normalized.extensions.events &&
    (normalized.transport.protocolVersions.length !== 1 ||
      normalized.transport.protocolVersions[0] !== LEGACY_PROTOCOL_VERSION)
  ) {
    throw new TypeError('Events require legacy-only protocol configuration')
  }
  return normalized
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
  const legacyProtocolVersion = options.transport?.protocolVersion ?? LEGACY_PROTOCOL_VERSION
  if (legacyProtocolVersion !== LEGACY_PROTOCOL_VERSION) {
    throw new TypeError(
      `transport.protocolVersion is reserved for legacy initialize and must be "${LEGACY_PROTOCOL_VERSION}"; configure modern support with transport.protocolVersions`
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

function normalizeCore(options: McpPluginOptions): NormalizedMcpPluginOptions['core'] {
  const continuation = options.core?.continuation
  const pagination = options.core?.pagination
  const subscriptions = options.core?.subscriptions
  if (continuation) {
    assertSigningKey(continuation.signingKey, 'Continuation')
    if (
      continuation.ttlMs !== undefined &&
      (!Number.isSafeInteger(continuation.ttlMs) || continuation.ttlMs <= 0)
    ) {
      throw new TypeError('Continuation ttlMs must be a positive integer')
    }
    if (continuation.singleUse && !continuation.provider) {
      throw new TypeError('Single-use continuation protection requires an application provider')
    }
  }
  if (pagination) {
    assertSigningKey(pagination.signingKey, 'Pagination')
    if (!Number.isSafeInteger(pagination.pageSize) || pagination.pageSize <= 0) {
      throw new TypeError('Pagination pageSize must be a positive integer')
    }
    if (
      pagination.cursorTtlMs !== undefined &&
      (!Number.isSafeInteger(pagination.cursorTtlMs) || pagination.cursorTtlMs <= 0)
    ) {
      throw new TypeError('Pagination cursorTtlMs must be a positive integer')
    }
  }
  const cacheDefault = options.core?.cache?.default
  const ttlMs = cacheDefault?.ttlMs ?? 0
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 0) {
    throw new TypeError('Cache ttlMs must be a non-negative integer')
  }
  if (
    subscriptions?.heartbeatMs !== undefined &&
    (!Number.isSafeInteger(subscriptions.heartbeatMs) || subscriptions.heartbeatMs <= 0)
  ) {
    throw new TypeError('Subscription heartbeatMs must be a positive integer')
  }
  return {
    continuation: continuation
      ? {
          ...continuation,
          ttlMs: continuation.ttlMs ?? 5 * 60_000,
          singleUse: continuation.singleUse ?? false
        }
      : undefined,
    pagination: pagination
      ? { ...pagination, cursorTtlMs: pagination.cursorTtlMs ?? 5 * 60_000 }
      : undefined,
    cache: {
      default: { cacheScope: cacheDefault?.cacheScope ?? 'private', ttlMs },
      policy: options.core?.cache?.policy
    },
    subscriptions: subscriptions
      ? { ...subscriptions, heartbeatMs: subscriptions.heartbeatMs ?? 15_000 }
      : undefined
  }
}

function assertSigningKey(key: string | Uint8Array, label: string): void {
  const bytes = typeof key === 'string' ? new TextEncoder().encode(key) : key
  if (bytes.byteLength < 32)
    throw new TypeError(`${label} signingKey must contain at least 32 bytes`)
}

function assertEventTimerDelay(value: number | undefined, label: string, maximum: number): void {
  if (value !== undefined && value > maximum)
    throw new RangeError(`Events ${label} must not exceed ${maximum} milliseconds`)
}

function normalizeExtensions(options: McpPluginOptions): NormalizedMcpPluginOptions['extensions'] {
  const tasks = options.extensions?.tasks
  const auth = options.extensions?.auth
  const apps = options.extensions?.apps
  const skills = options.extensions?.skills
  const events = options.extensions?.events

  if (
    tasks?.defaultTtl !== undefined &&
    tasks.defaultTtl !== null &&
    (!Number.isSafeInteger(tasks.defaultTtl) || tasks.defaultTtl < 0)
  ) {
    throw new TypeError(
      'Tasks defaultTtl must be a non-negative integer number of milliseconds or null'
    )
  }
  if (events) {
    if (!events.cursor) throw new TypeError('Events require cursor signing configuration')
    assertSigningKey(events.cursor.signingKey, 'Events cursor')
    for (const [label, value] of [
      ['cursor ttlMs', events.cursor.ttlMs],
      ['heartbeatMs', events.heartbeatMs],
      ['pollIntervalMs', events.pollIntervalMs],
      ['pollLeaseMs', events.pollLeaseMs],
      ['maxEvents', events.maxEvents],
      ['maxAgeMs', events.maxAgeMs === 0 ? undefined : events.maxAgeMs]
    ] as const) {
      if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0))
        throw new TypeError(`Events ${label} must be a positive integer`)
    }
    assertEventTimerDelay(events.heartbeatMs, 'heartbeatMs', 30_000)
    assertEventTimerDelay(events.pollIntervalMs, 'pollIntervalMs', MAX_TIMER_DELAY_MS)
    assertEventTimerDelay(events.pollLeaseMs, 'pollLeaseMs', MAX_TIMER_DELAY_MS)
    if (events.provider && !events.pagination)
      throw new TypeError('Events providers require pagination configuration')
    if (events.pagination) {
      assertSigningKey(events.pagination.signingKey, 'Events pagination')
      if (!Number.isSafeInteger(events.pagination.pageSize) || events.pagination.pageSize <= 0)
        throw new TypeError('Events pagination pageSize must be a positive integer')
    }
    const webhook = events.webhook
    if (webhook) {
      if (webhook.allowNoExpiry && webhook.provider.durability !== 'durable')
        throw new TypeError('No-expiry event subscriptions require a durable provider')
      if (webhook.allowPrivateAddresses && webhook.environment !== 'development')
        throw new TypeError('Private webhook callback addresses require environment "development"')
      const minTtlMs = webhook.minTtlMs ?? 60_000
      const defaultTtlMs = webhook.defaultTtlMs ?? 30 * 60_000
      const maxTtlMs = webhook.maxTtlMs ?? 24 * 60 * 60_000
      if (
        ![minTtlMs, defaultTtlMs, maxTtlMs].every(
          (value) => Number.isSafeInteger(value) && value > 0
        ) ||
        minTtlMs > defaultTtlMs ||
        defaultTtlMs > maxTtlMs
      )
        throw new TypeError('Events webhook TTL bounds are invalid')
      for (const [label, value] of [
        ['verificationTtlMs', webhook.verificationTtlMs ?? 30 * 60_000],
        ['challengeTtlMs', webhook.challengeTtlMs ?? 30_000],
        ['challengeRateLimitMs', webhook.challengeRateLimitMs ?? 10_000],
        ['requestTimeoutMs', webhook.requestTimeoutMs ?? 5_000],
        ['maxResponseBytes', webhook.maxResponseBytes ?? 64 * 1024],
        ['maxRequestBytes', webhook.maxRequestBytes ?? 256 * 1024],
        ['maxAttempts', webhook.maxAttempts ?? 4],
        ['maxRetryElapsedMs', webhook.maxRetryElapsedMs ?? 15 * 60_000],
        ['retryBaseMs', webhook.retryBaseMs ?? 1_000],
        ['secretRotationGraceMs', webhook.secretRotationGraceMs ?? 5 * 60_000],
        ['maxSubscriptionsPerPrincipal', webhook.maxSubscriptionsPerPrincipal ?? 100]
      ] as const)
        if (!Number.isSafeInteger(value) || value <= 0)
          throw new TypeError(`Events webhook ${label} must be a positive integer`)
      for (const [label, value] of [
        ['webhook requestTimeoutMs', webhook.requestTimeoutMs ?? 5_000],
        ['webhook maxRetryElapsedMs', webhook.maxRetryElapsedMs ?? 15 * 60_000],
        ['webhook retryBaseMs', webhook.retryBaseMs ?? 1_000]
      ] as const)
        assertEventTimerDelay(value, label, MAX_TIMER_DELAY_MS)
    }
  }
  if (
    skills?.version !== undefined &&
    skills.version !== 'current' &&
    skills.version !== MCP_SKILLS_VERSION
  ) {
    throw new TypeError(`Unsupported skills specification version "${skills.version}"`)
  }
  if (skills?.pagination) {
    assertSigningKey(skills.pagination.signingKey, 'Skills pagination')
    if (!Number.isSafeInteger(skills.pagination.pageSize) || skills.pagination.pageSize <= 0) {
      throw new TypeError('Skills pagination pageSize must be a positive integer')
    }
    if (
      skills.pagination.cursorTtlMs !== undefined &&
      (!Number.isSafeInteger(skills.pagination.cursorTtlMs) || skills.pagination.cursorTtlMs <= 0)
    ) {
      throw new TypeError('Skills pagination cursorTtlMs must be a positive integer')
    }
  }
  const skillsTtl = skills?.cache?.ttlMs ?? 0
  const skillsScope = skills?.cache?.cacheScope ?? 'private'
  if (!Number.isSafeInteger(skillsTtl) || skillsTtl < 0) {
    throw new TypeError('Skills cache ttlMs must be a non-negative integer')
  }
  if (skillsScope !== 'private' && skillsScope !== 'public') {
    throw new TypeError('Skills cache cacheScope must be private or public')
  }
  if (
    tasks?.pollInterval !== undefined &&
    (!Number.isSafeInteger(tasks.pollInterval) || tasks.pollInterval <= 0)
  ) {
    throw new TypeError('Tasks pollInterval must be a positive integer number of milliseconds')
  }
  if (
    auth?.clockSkewSeconds !== undefined &&
    (!Number.isFinite(auth.clockSkewSeconds) || auth.clockSkewSeconds < 0)
  ) {
    throw new TypeError('Auth clockSkewSeconds must be a finite non-negative number')
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
      : undefined,
    skills: skills
      ? {
          ...skills,
          version: MCP_SKILLS_VERSION,
          directoryRead: skills.directoryRead ?? false,
          pagination: skills.pagination
            ? {
                ...skills.pagination,
                cursorTtlMs: skills.pagination.cursorTtlMs ?? 5 * 60_000
              }
            : undefined,
          cache: { cacheScope: skillsScope, ttlMs: skillsTtl }
        }
      : undefined,
    serverCard: options.extensions?.serverCard
      ? normalizeServerCardOptions(options.extensions.serverCard)
      : undefined,
    interceptors: options.extensions?.interceptors
      ? {
          ...options.extensions.interceptors,
          version: resolveExperimentalRevision(
            'interceptors',
            options.extensions.interceptors.version,
            MCP_INTERCEPTORS_REVISION
          )
        }
      : undefined,
    variants: normalizeVariants(options.extensions?.variants),
    events: events
      ? {
          ...events,
          version: resolveExperimentalRevision('events', events.version, MCP_EVENTS_REVISION),
          cursor: { ...events.cursor, ttlMs: events.cursor.ttlMs ?? 24 * 60 * 60_000 },
          heartbeatMs: events.heartbeatMs ?? 15_000,
          pollIntervalMs: events.pollIntervalMs ?? 5_000,
          pollLeaseMs: events.pollLeaseMs ?? 15_000,
          maxEvents: events.maxEvents ?? 100,
          maxAgeMs: events.maxAgeMs ?? 24 * 60 * 60_000,
          pagination: events.pagination
            ? { ...events.pagination, cursorTtlMs: events.pagination.cursorTtlMs ?? 5 * 60_000 }
            : undefined,
          webhook: events.webhook
            ? {
                ...events.webhook,
                defaultTtlMs: events.webhook.defaultTtlMs ?? 30 * 60_000,
                minTtlMs: events.webhook.minTtlMs ?? 60_000,
                maxTtlMs: events.webhook.maxTtlMs ?? 24 * 60 * 60_000,
                allowNoExpiry: events.webhook.allowNoExpiry ?? false,
                allowPrivateAddresses: events.webhook.allowPrivateAddresses ?? false,
                environment: events.webhook.environment ?? 'production',
                verificationTtlMs: events.webhook.verificationTtlMs ?? 30 * 60_000,
                challengeTtlMs: events.webhook.challengeTtlMs ?? 30_000,
                challengeRateLimitMs: events.webhook.challengeRateLimitMs ?? 10_000,
                requestTimeoutMs: events.webhook.requestTimeoutMs ?? 5_000,
                maxResponseBytes: events.webhook.maxResponseBytes ?? 64 * 1024,
                maxRequestBytes: events.webhook.maxRequestBytes ?? 256 * 1024,
                maxAttempts: events.webhook.maxAttempts ?? 4,
                maxRetryElapsedMs: events.webhook.maxRetryElapsedMs ?? 15 * 60_000,
                retryBaseMs: events.webhook.retryBaseMs ?? 1_000,
                secretRotationGraceMs: events.webhook.secretRotationGraceMs ?? 5 * 60_000,
                maxSubscriptionsPerPrincipal: events.webhook.maxSubscriptionsPerPrincipal ?? 100
              }
            : undefined
        }
      : undefined
  }
}

function normalizeVariants(
  value: McpVariantsOptions | undefined
): NormalizedMcpPluginOptions['extensions']['variants'] {
  if (!value) return undefined
  const version = resolveExperimentalRevision(
    'server variants',
    value.version,
    MCP_SERVER_VARIANTS_REVISION
  )
  if (!Array.isArray(value.variants) || value.variants.length === 0)
    throw new TypeError('Server variants require at least one configured variant')
  const ids = new Set<string>()
  for (const variant of value.variants) {
    if (
      !variant ||
      typeof variant.id !== 'string' ||
      !variant.id ||
      typeof variant.description !== 'string' ||
      !variant.description
    )
      throw new TypeError('Server variant identity is invalid')
    if (ids.has(variant.id)) throw new TypeError(`Duplicate server variant: ${variant.id}`)
    ids.add(variant.id)
    if (
      variant.status !== undefined &&
      !['stable', 'experimental', 'deprecated'].includes(variant.status)
    )
      throw new TypeError(`Server variant ${variant.id} has an invalid status`)
    if (
      variant.hints !== undefined &&
      (typeof variant.hints !== 'object' ||
        Array.isArray(variant.hints) ||
        Object.values(variant.hints).some((hint) => typeof hint !== 'string'))
    )
      throw new TypeError(`Server variant ${variant.id} has invalid hints`)
    for (const [kind, entries] of [
      ['tools', variant.tools],
      ['resources', variant.resources],
      ['prompts', variant.prompts]
    ] as const) {
      if (
        entries !== undefined &&
        (!Array.isArray(entries) ||
          entries.some((entry) => typeof entry !== 'string' || entry.length === 0) ||
          new Set(entries).size !== entries.length)
      )
        throw new TypeError(`Server variant ${variant.id} has an invalid ${kind} registry`)
    }
    if (variant.deprecationInfo !== undefined) {
      const info = variant.deprecationInfo
      if (
        !info ||
        typeof info !== 'object' ||
        typeof info.message !== 'string' ||
        !info.message ||
        (info.replacement !== undefined && typeof info.replacement !== 'string') ||
        (info.removalDate !== undefined &&
          (typeof info.removalDate !== 'string' ||
            !/^\d{4}-\d{2}-\d{2}(?:T.*)?$/u.test(info.removalDate) ||
            Number.isNaN(Date.parse(info.removalDate))))
      )
        throw new TypeError(`Server variant ${variant.id} has invalid deprecationInfo`)
    }
  }
  const discoveryLimit = value.discoveryLimit ?? 5
  if (!Number.isSafeInteger(discoveryLimit) || discoveryLimit < 1)
    throw new TypeError('Variant discoveryLimit must be positive')
  return { ...value, version, discoveryLimit }
}

function resolveExperimentalRevision<T extends string>(
  label: string,
  value: 'current' | T | undefined,
  revision: T
): T {
  if (value === undefined || value === 'current' || value === revision) return revision
  throw new TypeError(`Unsupported ${label} revision: ${value}`)
}

function normalizeEndpointPath(path: string): string {
  if (!path.startsWith('/')) return `/${path}`
  return path
}

function normalizeHeaderNames(headers: string[]): string[] {
  return Array.from(new Set(headers.map((header) => header.trim().toLowerCase()).filter(Boolean)))
}
