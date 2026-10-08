import type {
  JsonSchema,
  McpAuthorizationOptions,
  McpInvocationContext,
  McpPaginationOptions
} from '../../types.js'
import type { McpAuthorizationContext } from '../auth/index.js'

export const MCP_EVENTS_REVISION = '6682596d65eec778fe0b8b1f43b4e89d2fe2c546' as const
export const MCP_EVENTS_CAPABILITY = 'events' as const
export const MCP_EVENT_SUBSCRIPTION_META_KEY = 'io.modelcontextprotocol/subscriptionId' as const

export type McpEventDeliveryMode = 'poll' | 'push' | 'webhook'

export interface McpEventDescriptor {
  name: string
  description: string
  delivery: McpEventDeliveryMode[]
  inputSchema: JsonSchema
  payloadSchema: JsonSchema
  _meta?: Record<string, unknown>
}

export interface McpEventDefinition extends McpEventDescriptor {
  authorization?: McpAuthorizationOptions
  authorize?: McpEventAuthorizer
  onSubscribe?: McpEventLifecycleHandler
  onUnsubscribe?: McpEventLifecycleHandler
}

export interface McpEventOccurrence {
  eventId: string
  name: string
  timestamp: string
  data: Record<string, unknown>
  cursor?: string | null
  _meta?: Record<string, unknown>
}

export interface McpEventPollRequest {
  name: string
  arguments: Record<string, unknown>
  cursor: string | null
  maxAgeMs?: number
  maxEvents: number
}

export interface McpEventPollResult {
  events: McpEventOccurrence[]
  cursor: string | null
  truncated?: boolean
  hasMore?: boolean
  nextPollMs?: number
  /** Ends push and webhook subscriptions. Poll requests return this as an error. */
  terminated?: McpEventError
}

export type McpEventHandler = (
  request: McpEventPollRequest,
  context: McpInvocationContext
) => McpEventPollResult | Promise<McpEventPollResult>

export type McpEventAuthorizer = (
  arguments_: Readonly<Record<string, unknown>>,
  context: McpInvocationContext
) => boolean | Promise<boolean>

export type McpEventLifecycleHandler = (
  arguments_: Readonly<Record<string, unknown>>,
  subscriptionId: string,
  context: McpInvocationContext
) => void | Promise<void>

export interface McpEventRegistration {
  definition: McpEventDefinition
  handler: McpEventHandler
}

export interface McpEventProviderListRequest {
  offset: number
  limit?: number
}

export interface McpEventProviderPage {
  events: readonly McpEventDefinition[]
  hasMore?: boolean
}

export interface McpEventProvider {
  list(
    request: McpEventProviderListRequest,
    context: McpInvocationContext
  ): McpEventProviderPage | Promise<McpEventProviderPage>
  get(
    name: string,
    context: McpInvocationContext
  ): McpEventDefinition | null | Promise<McpEventDefinition | null>
  poll(
    request: McpEventPollRequest,
    context: McpInvocationContext
  ): McpEventPollResult | Promise<McpEventPollResult>
}

export interface McpEventCursorOptions {
  signingKey: string | Uint8Array
  ttlMs?: number
}

export type McpWebhookLastError =
  | 'connection_refused'
  | 'timeout'
  | 'tls_error'
  | 'http_4xx'
  | 'http_5xx'
  | 'challenge_failed'

export interface McpWebhookDeliveryStatus {
  active: boolean
  lastDeliveryAt?: string
  lastError: McpWebhookLastError | null
  failedSince?: string
  throttled?: boolean
  retryAfterMs?: number
}

export interface McpWebhookSubscriptionRecord {
  key: string
  id: string
  principal: string
  name: string
  arguments: Record<string, unknown>
  /** Persisted subscription configuration. This is never an upstream or client cursor. */
  maxAgeMs?: number
  url: string
  secret: string
  previousSecret?: string
  previousSecretExpiresAt?: number
  refreshBefore: string | null
  verified: boolean
  active: boolean
  createdAt: string
  updatedAt: string
  deliveryStatus?: McpWebhookDeliveryStatus
  variant?: string
}

export interface McpWebhookSubscriptionProvider {
  /** Durable providers persist subscriptions, verification, secrets, and TTL state across restarts. */
  readonly durability: 'durable' | 'ephemeral'
  get(
    key: string
  ): McpWebhookSubscriptionRecord | null | Promise<McpWebhookSubscriptionRecord | null>
  upsert(
    record: McpWebhookSubscriptionRecord,
    options: { maxSubscriptionsPerPrincipal: number }
  ):
    | { record: McpWebhookSubscriptionRecord; created: boolean }
    | { limitExceeded: true }
    | Promise<{ record: McpWebhookSubscriptionRecord; created: boolean } | { limitExceeded: true }>
  delete(key: string): boolean | undefined | Promise<boolean | undefined>
  list():
    | AsyncIterable<McpWebhookSubscriptionRecord>
    | Promise<AsyncIterable<McpWebhookSubscriptionRecord>>
  authorizeDelivery(
    record: Readonly<McpWebhookSubscriptionRecord>
  ): McpAuthorizationContext | false | null | Promise<McpAuthorizationContext | false | null>
}

export interface McpWebhookAddress {
  address: string
  family: 4 | 6
}

export interface McpEventWebhookOptions {
  provider: McpWebhookSubscriptionProvider
  defaultTtlMs?: number
  minTtlMs?: number
  maxTtlMs?: number
  allowNoExpiry?: boolean
  allowPrivateAddresses?: boolean
  environment?: 'production' | 'development'
  allowlist?: (url: URL, context: McpInvocationContext) => boolean | Promise<boolean>
  resolveAddresses?: (hostname: string) => Promise<readonly McpWebhookAddress[]>
  verificationTtlMs?: number
  challengeTtlMs?: number
  challengeRateLimitMs?: number
  requestTimeoutMs?: number
  maxResponseBytes?: number
  maxRequestBytes?: number
  maxAttempts?: number
  maxRetryElapsedMs?: number
  retryBaseMs?: number
  secretRotationGraceMs?: number
  maxSubscriptionsPerPrincipal?: number
}

export interface McpEventsOptions {
  version?: 'current' | typeof MCP_EVENTS_REVISION
  authorization?: McpAuthorizationOptions
  provider?: McpEventProvider
  pagination?: McpPaginationOptions
  cursor: McpEventCursorOptions
  heartbeatMs?: number
  pollIntervalMs?: number
  pollLeaseMs?: number
  maxEvents?: number
  maxAgeMs?: number
  webhook?: McpEventWebhookOptions
}

export interface NormalizedMcpEventsOptions extends Omit<McpEventsOptions, 'version'> {
  version: typeof MCP_EVENTS_REVISION
  cursor: McpEventCursorOptions & { ttlMs: number }
  heartbeatMs: number
  pollIntervalMs: number
  pollLeaseMs: number
  maxEvents: number
  maxAgeMs: number
  pagination?: McpPaginationOptions & { cursorTtlMs: number }
  webhook?: Required<Omit<McpEventWebhookOptions, 'allowlist' | 'resolveAddresses' | 'provider'>> &
    Pick<McpEventWebhookOptions, 'allowlist' | 'resolveAddresses' | 'provider'>
}

export interface McpEventError {
  code: number
  message: string
  data?: Record<string, unknown>
}
