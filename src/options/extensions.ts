import { resolveAuthVersion } from '../extensions/auth/index.js'
import { MCP_EVENTS_REVISION } from '../extensions/events/index.js'
import { MCP_INTERCEPTORS_REVISION } from '../extensions/interceptors/index.js'
import { MCP_EXTENSION_SUPPORT, resolvePinnedVersion } from '../extensions/manifest.js'
import { normalizeServerCardOptions } from '../extensions/server-card/index.js'
import { MCP_SKILLS_VERSION } from '../extensions/skills/index.js'
import { resolveTasksVersion } from '../extensions/tasks/index.js'
import type { McpPluginOptions, NormalizedMcpPluginOptions } from '../types.js'
import {
  assertNonNegativeInteger,
  assertPositiveInteger,
  assertSigningKey,
  assertTimerDelay,
  MAX_TIMER_DELAY_MS,
  resolveExperimentalRevision,
  withDefault
} from './validation.js'
import { normalizeVariants } from './variants.js'

type Extensions = NonNullable<McpPluginOptions['extensions']>
type EventsOptions = NonNullable<Extensions['events']>
type SkillsOptions = NonNullable<Extensions['skills']>
type AuthOptions = NonNullable<Extensions['auth']>

function normalizeTasks(
  tasks: Extensions['tasks']
): NormalizedMcpPluginOptions['extensions']['tasks'] {
  if (!tasks) return undefined
  if (tasks.defaultTtl !== undefined && tasks.defaultTtl !== null) {
    assertNonNegativeInteger(tasks.defaultTtl, 'Tasks defaultTtl')
  }
  assertPositiveInteger(tasks.pollInterval, 'Tasks pollInterval')
  return { ...tasks, version: resolveTasksVersion(tasks.version) }
}

function normalizeAuth(auth: Extensions['auth']): NormalizedMcpPluginOptions['extensions']['auth'] {
  if (!auth) return undefined
  if (auth.clockSkewSeconds !== undefined) {
    if (!Number.isFinite(auth.clockSkewSeconds) || auth.clockSkewSeconds < 0) {
      throw new TypeError('Auth clockSkewSeconds must be a finite non-negative number')
    }
  }
  return {
    ...auth,
    profiles: normalizeAuthProfiles(auth),
    version: resolveAuthVersion('core', auth.version) as Exclude<
      NonNullable<typeof auth.version>,
      'current'
    >
  }
}

function normalizeAuthProfiles(
  auth: AuthOptions
): NormalizedMcpPluginOptions['extensions']['auth'] extends infer A
  ? A extends { profiles?: infer P }
    ? P
    : never
  : never {
  const clientCredentials = auth.profiles?.clientCredentials
  const enterpriseManaged = auth.profiles?.enterpriseManaged
  return {
    clientCredentials:
      clientCredentials === true
        ? true
        : clientCredentials
          ? {
              version: resolveAuthVersion(
                'client-credentials',
                clientCredentials.version
              ) as 'draft'
            }
          : undefined,
    enterpriseManaged:
      enterpriseManaged === true
        ? true
        : enterpriseManaged
          ? {
              version: resolveAuthVersion(
                'enterprise-managed',
                enterpriseManaged.version
              ) as '2026-06-17'
            }
          : undefined
  }
}

function normalizeApps(apps: Extensions['apps']): NormalizedMcpPluginOptions['extensions']['apps'] {
  if (!apps) return undefined
  return {
    ...apps,
    version: resolvePinnedVersion(
      'apps',
      apps.version,
      MCP_EXTENSION_SUPPORT.apps.current,
      MCP_EXTENSION_SUPPORT.apps.versions
    )
  }
}

function validateSkills(skills: SkillsOptions): void {
  const supported = [undefined, 'current', MCP_SKILLS_VERSION].some(
    (version) => version === skills.version
  )
  if (!supported) {
    throw new TypeError(`Unsupported skills specification version "${skills.version}"`)
  }
  const pagination = skills.pagination
  if (pagination) {
    assertSigningKey(pagination.signingKey, 'Skills pagination')
    assertPositiveInteger(pagination.pageSize, 'Skills pagination pageSize')
    assertPositiveInteger(pagination.cursorTtlMs, 'Skills pagination cursorTtlMs')
  }
  assertNonNegativeInteger(skills.cache?.ttlMs ?? 0, 'Skills cache ttlMs')
  const scope = skills.cache?.cacheScope ?? 'private'
  if (scope !== 'private' && scope !== 'public') {
    throw new TypeError('Skills cache cacheScope must be private or public')
  }
}

function normalizeSkills(
  skills: Extensions['skills']
): NormalizedMcpPluginOptions['extensions']['skills'] {
  if (!skills) return undefined
  validateSkills(skills)
  return {
    ...skills,
    version: MCP_SKILLS_VERSION,
    directoryRead: skills.directoryRead ?? false,
    pagination: skills.pagination
      ? { ...skills.pagination, cursorTtlMs: skills.pagination.cursorTtlMs ?? 5 * 60_000 }
      : undefined,
    cache: {
      cacheScope: skills.cache?.cacheScope ?? 'private',
      ttlMs: skills.cache?.ttlMs ?? 0
    }
  }
}

function validateEventCursor(events: EventsOptions): void {
  if (!events.cursor) throw new TypeError('Events require cursor signing configuration')
  assertSigningKey(events.cursor.signingKey, 'Events cursor')
  assertPositiveInteger(events.cursor.ttlMs, 'Events cursor ttlMs')
}

function validateEventTiming(events: EventsOptions): void {
  const values = [
    ['Events heartbeatMs', events.heartbeatMs],
    ['Events pollIntervalMs', events.pollIntervalMs],
    ['Events pollLeaseMs', events.pollLeaseMs],
    ['Events maxEvents', events.maxEvents],
    ['Events maxAgeMs', events.maxAgeMs === 0 ? undefined : events.maxAgeMs]
  ] as const
  for (const [label, value] of values) assertPositiveInteger(value, label)
  assertTimerDelay(events.heartbeatMs, 'Events heartbeatMs', 30_000)
  assertTimerDelay(events.pollIntervalMs, 'Events pollIntervalMs', MAX_TIMER_DELAY_MS)
  assertTimerDelay(events.pollLeaseMs, 'Events pollLeaseMs', MAX_TIMER_DELAY_MS)
}

function validateEventPagination(events: EventsOptions): void {
  if (events.provider && !events.pagination) {
    throw new TypeError('Events providers require pagination configuration')
  }
  if (!events.pagination) return
  assertSigningKey(events.pagination.signingKey, 'Events pagination')
  assertPositiveInteger(events.pagination.pageSize, 'Events pagination pageSize')
}

function validateWebhookPolicy(webhook: NonNullable<EventsOptions['webhook']>): void {
  if (webhook.allowNoExpiry && webhook.provider.durability !== 'durable') {
    throw new TypeError('No-expiry event subscriptions require a durable provider')
  }
  if (webhook.allowPrivateAddresses && webhook.environment !== 'development') {
    throw new TypeError('Private webhook callback addresses require environment "development"')
  }
  const min = withDefault(webhook.minTtlMs, 60_000)
  const initial = withDefault(webhook.defaultTtlMs, 30 * 60_000)
  const max = withDefault(webhook.maxTtlMs, 24 * 60 * 60_000)
  const valid = [min, initial, max].every((value) => Number.isSafeInteger(value) && value > 0)
  if (!valid || min > initial || initial > max) {
    throw new TypeError('Events webhook TTL bounds are invalid')
  }
}

function validateWebhookLimits(webhook: NonNullable<EventsOptions['webhook']>): void {
  const values = [
    ['verificationTtlMs', withDefault(webhook.verificationTtlMs, 30 * 60_000)],
    ['challengeTtlMs', withDefault(webhook.challengeTtlMs, 30_000)],
    ['challengeRateLimitMs', withDefault(webhook.challengeRateLimitMs, 10_000)],
    ['requestTimeoutMs', withDefault(webhook.requestTimeoutMs, 5_000)],
    ['maxResponseBytes', withDefault(webhook.maxResponseBytes, 64 * 1024)],
    ['maxRequestBytes', withDefault(webhook.maxRequestBytes, 256 * 1024)],
    ['maxAttempts', withDefault(webhook.maxAttempts, 4)],
    ['maxRetryElapsedMs', withDefault(webhook.maxRetryElapsedMs, 15 * 60_000)],
    ['retryBaseMs', withDefault(webhook.retryBaseMs, 1_000)],
    ['secretRotationGraceMs', withDefault(webhook.secretRotationGraceMs, 5 * 60_000)],
    ['maxSubscriptionsPerPrincipal', withDefault(webhook.maxSubscriptionsPerPrincipal, 100)]
  ] as const
  for (const [label, value] of values) assertPositiveInteger(value, `Events webhook ${label}`)
  assertTimerDelay(
    withDefault(webhook.requestTimeoutMs, 5_000),
    'Events webhook requestTimeoutMs',
    MAX_TIMER_DELAY_MS
  )
  assertTimerDelay(
    withDefault(webhook.maxRetryElapsedMs, 15 * 60_000),
    'Events webhook maxRetryElapsedMs',
    MAX_TIMER_DELAY_MS
  )
  assertTimerDelay(
    withDefault(webhook.retryBaseMs, 1_000),
    'Events webhook retryBaseMs',
    MAX_TIMER_DELAY_MS
  )
}

function normalizeWebhook(
  webhook: EventsOptions['webhook']
): NonNullable<NormalizedMcpPluginOptions['extensions']['events']>['webhook'] {
  if (!webhook) return undefined
  validateWebhookPolicy(webhook)
  validateWebhookLimits(webhook)
  return {
    ...webhook,
    defaultTtlMs: withDefault(webhook.defaultTtlMs, 30 * 60_000),
    minTtlMs: withDefault(webhook.minTtlMs, 60_000),
    maxTtlMs: withDefault(webhook.maxTtlMs, 24 * 60 * 60_000),
    allowNoExpiry: withDefault(webhook.allowNoExpiry, false),
    allowPrivateAddresses: withDefault(webhook.allowPrivateAddresses, false),
    environment: withDefault(webhook.environment, 'production'),
    verificationTtlMs: withDefault(webhook.verificationTtlMs, 30 * 60_000),
    challengeTtlMs: withDefault(webhook.challengeTtlMs, 30_000),
    challengeRateLimitMs: withDefault(webhook.challengeRateLimitMs, 10_000),
    requestTimeoutMs: withDefault(webhook.requestTimeoutMs, 5_000),
    maxResponseBytes: withDefault(webhook.maxResponseBytes, 64 * 1024),
    maxRequestBytes: withDefault(webhook.maxRequestBytes, 256 * 1024),
    maxAttempts: withDefault(webhook.maxAttempts, 4),
    maxRetryElapsedMs: withDefault(webhook.maxRetryElapsedMs, 15 * 60_000),
    retryBaseMs: withDefault(webhook.retryBaseMs, 1_000),
    secretRotationGraceMs: withDefault(webhook.secretRotationGraceMs, 5 * 60_000),
    maxSubscriptionsPerPrincipal: withDefault(webhook.maxSubscriptionsPerPrincipal, 100)
  }
}

function normalizeEvents(
  events: Extensions['events']
): NormalizedMcpPluginOptions['extensions']['events'] {
  if (!events) return undefined
  validateEventCursor(events)
  validateEventTiming(events)
  validateEventPagination(events)
  return {
    ...events,
    version: resolveExperimentalRevision('events', events.version, MCP_EVENTS_REVISION),
    cursor: { ...events.cursor, ttlMs: withDefault(events.cursor.ttlMs, 24 * 60 * 60_000) },
    heartbeatMs: withDefault(events.heartbeatMs, 15_000),
    pollIntervalMs: withDefault(events.pollIntervalMs, 5_000),
    pollLeaseMs: withDefault(events.pollLeaseMs, 15_000),
    maxEvents: withDefault(events.maxEvents, 100),
    maxAgeMs: withDefault(events.maxAgeMs, 24 * 60 * 60_000),
    pagination: events.pagination
      ? { ...events.pagination, cursorTtlMs: events.pagination.cursorTtlMs ?? 5 * 60_000 }
      : undefined,
    webhook: normalizeWebhook(events.webhook)
  }
}

export function normalizeExtensions(
  options: McpPluginOptions
): NormalizedMcpPluginOptions['extensions'] {
  const extensions = options.extensions
  return {
    tasks: normalizeTasks(extensions?.tasks),
    auth: normalizeAuth(extensions?.auth),
    apps: normalizeApps(extensions?.apps),
    skills: normalizeSkills(extensions?.skills),
    serverCard: extensions?.serverCard
      ? normalizeServerCardOptions(extensions.serverCard)
      : undefined,
    interceptors: extensions?.interceptors
      ? {
          ...extensions.interceptors,
          version: resolveExperimentalRevision(
            'interceptors',
            extensions.interceptors.version,
            MCP_INTERCEPTORS_REVISION
          )
        }
      : undefined,
    variants: normalizeVariants(extensions?.variants),
    events: normalizeEvents(extensions?.events)
  }
}
