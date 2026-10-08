import { LEGACY_PROTOCOL_VERSION } from '../../constants.js'
import { getMcpRegistry } from '../../registry.js'
import { decodeCursor, encodeCursor } from '../../transport/core.js'
import type { AnyElysiaApp, McpInvocationContext, NormalizedMcpPluginOptions } from '../../types.js'
import { missingRequiredScopes } from '../auth/index.js'
import {
  canonicalJson,
  decodeEventCursor,
  encodeEventCursor,
  eventPrincipalKey,
  eventVariantKey
} from './cursor.js'
import { abortableDelay } from './delay.js'
import { McpWebhookNetworkError, parseWebhookUrl } from './network.js'
import {
  eventRuntimeState,
  nextWebhookLifecycleEpoch,
  retireWebhookLifecycleEpoch,
  type WebhookWorkerState,
  webhookLifecycleEpoch,
  webhookWorkers,
  withWebhookLifecycleLock
} from './runtime-state.js'
import type {
  McpEventDefinition,
  McpEventDescriptor,
  McpEventError,
  McpEventOccurrence,
  McpEventPollRequest,
  McpEventPollResult,
  McpEventRegistration,
  McpWebhookDeliveryStatus,
  McpWebhookSubscriptionRecord,
  NormalizedMcpEventsOptions
} from './types.js'
import {
  assertEventArguments,
  assertEventDefinition,
  assertEventPollResult,
  eventDescriptor,
  incompatibleEventSchema
} from './validation.js'
import {
  assertWebhookSecret,
  deliverWebhook,
  deriveWebhookSubscriptionIdentity,
  McpWebhookDeliveryRevokedError,
  McpWebhookVerificationError,
  verifyWebhookEndpoint,
  webhookControlMessageId
} from './webhook.js'

interface EventSource {
  definition: McpEventDefinition
  registration?: McpEventRegistration
}

export class McpEventProtocolError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: Record<string, unknown>,
    readonly status = 200
  ) {
    super(message)
  }
}

export async function listEvents(
  app: AnyElysiaApp,
  params: Record<string, unknown>,
  request: Request,
  options: NormalizedMcpPluginOptions,
  context: McpInvocationContext
): Promise<Record<string, unknown>> {
  const config = eventOptions(options)
  await authorizeExtension(config, context)
  if (params.cursor !== undefined && !config.pagination)
    throw invalidParams('Events pagination is not configured')
  const offset = config.pagination
    ? decodeCursor(params.cursor, 'events/list', params, context, options, config.pagination)
    : 0
  const local = [...(getMcpRegistry(app, options).events?.values() ?? [])]
  const visibleLocal = local
    .map(({ definition }) => definition)
    .filter((definition) => hasScopes(definition.authorization, context))
  const pageSize = config.pagination?.pageSize
  const page =
    offset < visibleLocal.length
      ? localEventPage(visibleLocal, offset, pageSize, config)
      : await providerEventPage(
          local,
          visibleLocal.length,
          offset,
          pageSize,
          config,
          request,
          context
        )
  return {
    events: page.events,
    ...(page.nextOffset !== undefined && config.pagination
      ? {
          nextCursor: encodeCursor(
            'events/list',
            page.nextOffset,
            params,
            context,
            options,
            config.pagination
          )
        }
      : {})
  }
}

interface EventListPage {
  events: McpEventDescriptor[]
  nextOffset?: number
}

function localEventPage(
  visible: McpEventDefinition[],
  offset: number,
  pageSize: number | undefined,
  config: NormalizedMcpEventsOptions
): EventListPage {
  const end = Math.min(visible.length, offset + (pageSize ?? visible.length))
  const events = visible
    .slice(offset, end)
    .map((definition) => configuredEventDescriptor(definition, config))
    .filter((definition): definition is McpEventDescriptor => definition !== undefined)
  return end < visible.length || config.provider ? { events, nextOffset: end } : { events }
}

async function providerEventPage(
  local: McpEventRegistration[],
  localCount: number,
  offset: number,
  pageSize: number | undefined,
  config: NormalizedMcpEventsOptions,
  request: Request,
  context: McpInvocationContext
): Promise<EventListPage> {
  if (!config.provider) {
    if (offset > localCount) throw invalidParams('Invalid events pagination cursor')
    return { events: [] }
  }
  const providerOffset = offset - localCount
  const page = await config.provider.list(
    { offset: providerOffset, limit: pageSize },
    { ...context, request }
  )
  assertProviderPage(page, pageSize)
  const events = providerDescriptors(page.events, local, config, context)
  return page.hasMore
    ? { events, nextOffset: localCount + providerOffset + page.events.length }
    : { events }
}

function assertProviderPage(
  page: Awaited<ReturnType<NonNullable<NormalizedMcpEventsOptions['provider']>['list']>>,
  pageSize: number | undefined
): void {
  const invalid =
    !page ||
    !Array.isArray(page.events) ||
    (page.hasMore !== undefined && typeof page.hasMore !== 'boolean') ||
    (pageSize !== undefined && page.events.length > pageSize) ||
    (page.hasMore === true && page.events.length === 0)
  if (invalid) throw internalError('Event provider returned an invalid page')
}

function providerDescriptors(
  definitions: readonly McpEventDefinition[],
  local: McpEventRegistration[],
  config: NormalizedMcpEventsOptions,
  context: McpInvocationContext
): McpEventDescriptor[] {
  const localByName = new Map(local.map(({ definition }) => [definition.name, definition]))
  const output: McpEventDescriptor[] = []
  for (const definition of definitions) {
    assertProviderDefinition(definition)
    const localDefinition = localByName.get(definition.name)
    if (localDefinition) assertMatchingDefinition(localDefinition, definition)
    else addVisibleDescriptor(output, definition, config, context)
  }
  return output
}

function assertMatchingDefinition(local: McpEventDefinition, provided: McpEventDefinition): void {
  if (canonicalJson(eventDescriptor(local)) !== canonicalJson(eventDescriptor(provided)))
    throw internalError('Event provider conflicts with an explicit event')
}

function addVisibleDescriptor(
  output: McpEventDescriptor[],
  definition: McpEventDefinition,
  config: NormalizedMcpEventsOptions,
  context: McpInvocationContext
): void {
  const descriptor = configuredEventDescriptor(definition, config)
  if (descriptor && hasScopes(definition.authorization, context)) output.push(descriptor)
}

export async function pollEvents(
  app: AnyElysiaApp,
  params: Record<string, unknown>,
  options: NormalizedMcpPluginOptions,
  context: McpInvocationContext
): Promise<Record<string, unknown>> {
  const prepared = await prepareEventRequest(app, params, 'poll', options, context)
  const result = await pollSource(prepared.source, prepared.request, context, options)
  if (result.terminated) throw eventError(result.terminated)
  if (prepared.initial) {
    result.events = []
    result.hasMore = false
  }
  if (prepared.cursorExpired) result.truncated = true
  await renewPollLease(app, prepared, context, options)
  return serializePollResult(result, prepared, context, options, false)
}

export async function streamEvents(
  app: AnyElysiaApp,
  params: Record<string, unknown>,
  parentId: string | number,
  options: NormalizedMcpPluginOptions,
  context: McpInvocationContext
): Promise<Response> {
  const prepared = await prepareEventRequest(app, params, 'push', options, context)
  const initial = await pollSource(prepared.source, prepared.request, context, options)
  if (initial.terminated) throw eventError(initial.terminated)
  if (prepared.initial) {
    initial.events = []
    initial.hasMore = false
  }
  if (prepared.cursorExpired) initial.truncated = true
  await prepared.source.definition.onSubscribe?.(
    prepared.request.arguments,
    String(parentId),
    context
  )
  const originalDescriptor = eventDescriptor(prepared.source.definition)
  const abort = new AbortController()
  const relay = () => abort.abort(context.signal?.reason)
  if (context.signal?.aborted) abort.abort(context.signal.reason)
  else context.signal?.addEventListener('abort', relay, { once: true })
  let session: EventStreamSession | undefined
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      session = createEventStreamSession(
        app,
        parentId,
        options,
        context,
        prepared,
        initial,
        originalDescriptor,
        abort,
        relay,
        controller
      )
      void runEventStream(session)
    },
    async cancel() {
      if (session) await cleanupEventStream(session)
    }
  })
  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive'
    }
  })
}

interface EventStreamSession {
  app: AnyElysiaApp
  parentId: string | number
  options: NormalizedMcpPluginOptions
  context: McpInvocationContext
  prepared: Awaited<ReturnType<typeof prepareEventRequest>>
  initial: McpEventPollResult
  originalDescriptor: McpEventDescriptor
  abort: AbortController
  relay: () => void
  controller: ReadableStreamDefaultController<Uint8Array>
  meta: Record<string, string | number>
  cursor: string | null
  heartbeat?: ReturnType<typeof setInterval>
  cleaned: boolean
}

function createEventStreamSession(
  app: AnyElysiaApp,
  parentId: string | number,
  options: NormalizedMcpPluginOptions,
  context: McpInvocationContext,
  prepared: Awaited<ReturnType<typeof prepareEventRequest>>,
  initial: McpEventPollResult,
  originalDescriptor: McpEventDescriptor,
  abort: AbortController,
  relay: () => void,
  controller: ReadableStreamDefaultController<Uint8Array>
): EventStreamSession {
  return {
    app,
    parentId,
    options,
    context,
    prepared,
    initial,
    originalDescriptor,
    abort,
    relay,
    controller,
    meta: { 'io.modelcontextprotocol/subscriptionId': parentId },
    cursor: prepared.initial || initial.truncated ? initial.cursor : prepared.request.cursor,
    cleaned: false
  }
}

async function runEventStream(session: EventStreamSession): Promise<void> {
  let serverClosed = false
  try {
    initializeEventStream(session)
    let nextPollMs = session.initial.nextPollMs ?? eventOptions(session.options).pollIntervalMs
    while (!session.abort.signal.aborted) {
      const tick = await pollEventStream(session, nextPollMs)
      if (tick.stop) {
        serverClosed = tick.serverClosed
        break
      }
      nextPollMs = tick.nextPollMs
    }
    if (serverClosed && !session.abort.signal.aborted) closeEventStream(session)
  } catch {
    if (!session.abort.signal.aborted) session.controller.error(new Error('Event stream failed'))
  } finally {
    await cleanupEventStream(session)
  }
}

function initializeEventStream(session: EventStreamSession): void {
  sendEventStream(session, {
    jsonrpc: '2.0',
    method: 'notifications/events/active',
    params: {
      cursor: encodedEventStreamCursor(session),
      truncated: session.initial.truncated ?? false,
      _meta: session.meta
    }
  })
  for (const occurrence of session.initial.events)
    sendEventStreamOccurrence(session, occurrence, session.initial.cursor !== null)
  if (session.initial.events.length === 0) session.cursor = session.initial.cursor
  startEventStreamHeartbeat(session)
}

interface EventStreamTick {
  stop: boolean
  serverClosed: boolean
  nextPollMs: number
}

async function pollEventStream(
  session: EventStreamSession,
  nextPollMs: number
): Promise<EventStreamTick> {
  const config = eventOptions(session.options)
  await abortableDelay(Math.min(nextPollMs, config.heartbeatMs), session.abort.signal)
  const current = await resolveEventStreamSource(session)
  if (!current) return { stop: true, serverClosed: true, nextPollMs }
  if (!validateEventStreamSource(session, current))
    return { stop: true, serverClosed: true, nextPollMs }
  return pollCurrentEventStreamSource(session, current, nextPollMs)
}

async function resolveEventStreamSource(session: EventStreamSession): Promise<EventSource | null> {
  try {
    const current = await resolveEventSource(
      session.app,
      session.prepared.request.name,
      session.context,
      session.options
    )
    await authorizeEvent(current.definition, session.prepared.request.arguments, session.context)
    return current
  } catch (error) {
    sendEventStream(
      session,
      eventNotification('terminated', {
        error: terminationForResolution(error),
        _meta: session.meta
      })
    )
    return null
  }
}

function validateEventStreamSource(session: EventStreamSession, current: EventSource): boolean {
  const schemaChange = incompatibleEventSchema(
    session.originalDescriptor,
    eventDescriptor(current.definition)
  )
  const deliveryRemoved = session.originalDescriptor.delivery.some(
    (mode) => !current.definition.delivery.includes(mode)
  )
  if (!deliveryRemoved && !schemaChange) return true
  sendEventStream(
    session,
    eventNotification('terminated', {
      error: {
        code: -32014,
        message: 'Unsupported',
        data: { feature: schemaChange ?? 'deliveryMode', reason: 'schema_changed' }
      },
      _meta: session.meta
    })
  )
  return false
}

async function pollCurrentEventStreamSource(
  session: EventStreamSession,
  current: EventSource,
  previousNextPollMs: number
): Promise<EventStreamTick> {
  try {
    const result = await pollSource(
      current,
      { ...session.prepared.request, cursor: session.cursor },
      { ...session.context, signal: session.abort.signal },
      session.options
    )
    if (result.terminated) {
      sendEventStream(
        session,
        eventNotification('terminated', { error: result.terminated, _meta: session.meta })
      )
      return { stop: true, serverClosed: true, nextPollMs: previousNextPollMs }
    }
    applyEventStreamPollResult(session, result)
    return {
      stop: false,
      serverClosed: false,
      nextPollMs: result.nextPollMs ?? eventOptions(session.options).pollIntervalMs
    }
  } catch {
    if (session.abort.signal.aborted)
      return { stop: true, serverClosed: false, nextPollMs: previousNextPollMs }
    sendEventStream(
      session,
      eventNotification('error', {
        error: { code: -32603, message: 'UpstreamError' },
        _meta: session.meta
      })
    )
    return { stop: false, serverClosed: false, nextPollMs: previousNextPollMs }
  }
}

function applyEventStreamPollResult(session: EventStreamSession, result: McpEventPollResult): void {
  if (result.truncated) {
    session.cursor = result.cursor
    sendEventStream(
      session,
      eventNotification('active', {
        cursor: encodedEventStreamCursor(session),
        truncated: true,
        _meta: session.meta
      })
    )
  }
  for (const occurrence of result.events)
    sendEventStreamOccurrence(session, occurrence, result.cursor !== null)
  if (result.events.length === 0) session.cursor = result.cursor
}

function sendEventStreamOccurrence(
  session: EventStreamSession,
  occurrence: McpEventOccurrence,
  replayable: boolean
): void {
  if (replayable && occurrence.cursor == null)
    throw internalError('Replayable push events require per-event cursors')
  session.cursor = occurrence.cursor ?? null
  sendEventStream(
    session,
    eventNotification('event', {
      ...occurrence,
      cursor: encodedEventStreamCursor(session),
      _meta: { ...occurrence._meta, ...session.meta }
    })
  )
}

function startEventStreamHeartbeat(session: EventStreamSession): void {
  session.heartbeat = setInterval(() => {
    if (session.abort.signal.aborted) return
    try {
      sendEventStream(
        session,
        eventNotification('heartbeat', {
          cursor: encodedEventStreamCursor(session),
          _meta: session.meta
        })
      )
    } catch {
      session.abort.abort('Event stream heartbeat failed')
    }
  }, eventOptions(session.options).heartbeatMs)
  session.heartbeat.unref?.()
}

function encodedEventStreamCursor(session: EventStreamSession): string | null {
  return encodeEventCursor(
    session.cursor,
    session.prepared.request.name,
    session.prepared.request.arguments,
    session.context.authorization,
    session.prepared.variant,
    eventOptions(session.options).cursor
  )
}

function sendEventStream(session: EventStreamSession, value: unknown): void {
  session.controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`))
}

function closeEventStream(session: EventStreamSession): void {
  sendEventStream(session, { jsonrpc: '2.0', id: session.parentId, result: { _meta: {} } })
  session.controller.close()
}

async function cleanupEventStream(session: EventStreamSession): Promise<void> {
  if (session.cleaned) return
  session.cleaned = true
  if (session.heartbeat) clearInterval(session.heartbeat)
  session.abort.abort('Event stream closed')
  session.context.signal?.removeEventListener('abort', session.relay)
  await session.prepared.source.definition.onUnsubscribe?.(
    session.prepared.request.arguments,
    String(session.parentId),
    session.context
  )
}

export async function subscribeEventsWebhook(
  app: AnyElysiaApp,
  params: Record<string, unknown>,
  options: NormalizedMcpPluginOptions,
  context: McpInvocationContext
): Promise<Record<string, unknown>> {
  const { config, webhook, principal } = webhookRequestEnvironment(options, context)
  const prepared = await prepareEventRequest(app, params, 'webhook', options, context)
  const delivery = parseWebhookDelivery(params.delivery)
  const identity = deriveWebhookSubscriptionIdentity(
    principal,
    delivery.url,
    prepared.request.name,
    prepared.request.arguments,
    config.cursor.signingKey,
    prepared.variant
  )
  const request: WebhookSubscriptionRequest = {
    app,
    params,
    options,
    context,
    config,
    webhook,
    principal,
    prepared,
    delivery,
    identity
  }
  return withWebhookLifecycleLock(app, options, identity.id, () => subscribeWebhookLocked(request))
}

interface WebhookDeliveryInput {
  url: string
  secret: string
}

interface WebhookSubscriptionRequest {
  app: AnyElysiaApp
  params: Record<string, unknown>
  options: NormalizedMcpPluginOptions
  context: McpInvocationContext
  config: NormalizedMcpEventsOptions
  webhook: NonNullable<NormalizedMcpEventsOptions['webhook']>
  principal: string
  prepared: Awaited<ReturnType<typeof prepareEventRequest>>
  delivery: WebhookDeliveryInput
  identity: { key: string; id: string }
}

interface WebhookSubscriptionFlow extends WebhookSubscriptionRequest {
  existing: McpWebhookSubscriptionRecord | null
  live?: WebhookWorkerState
  record: McpWebhookSubscriptionRecord
  refreshBefore: string | null
  cursor: string | null
  responseCursor: string | null
  responseTruncated: boolean
  initialResult?: McpEventPollResult
  activePrimed: boolean
  awaitInitialForSafeCursor: boolean
  lifecycleSubscribed: boolean
  releaseRefresh?: () => void
}

function parseWebhookDelivery(value: unknown): WebhookDeliveryInput {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw invalidParams('Webhook delivery is required')
  const delivery = value as Record<string, unknown>
  if (delivery.mode !== 'webhook' || typeof delivery.url !== 'string')
    throw invalidParams('Webhook delivery is invalid')
  try {
    parseWebhookUrl(delivery.url)
  } catch {
    throw invalidParams('Webhook URL is invalid')
  }
  return { url: delivery.url, secret: parseWebhookSecret(delivery.secret) }
}

function parseWebhookSecret(value: unknown): string {
  try {
    assertWebhookSecret(value)
    return value
  } catch (error) {
    throw invalidParams(error instanceof Error ? error.message : 'Webhook secret is invalid')
  }
}

async function subscribeWebhookLocked(
  request: WebhookSubscriptionRequest
): Promise<Record<string, unknown>> {
  const flow = await createWebhookSubscriptionFlow(request)
  await verifySubscriptionEndpoint(flow)
  await primeLiveWebhook(flow)
  await beginWebhookRefresh(flow)
  await storeWebhookSubscription(flow)
  await finishWebhookRefresh(flow)
  await ensureWebhookWorker(flow)
  return webhookSubscriptionResult(flow)
}

async function createWebhookSubscriptionFlow(
  request: WebhookSubscriptionRequest
): Promise<WebhookSubscriptionFlow> {
  const existing = await request.webhook.provider.get(request.identity.key)
  assertWebhookSubscriptionOwner(existing, request)
  const ttl = webhookGrant(request.params.ttlMs, request.webhook)
  const now = new Date()
  const refreshBefore = ttl === null ? null : new Date(now.getTime() + ttl).toISOString()
  const live = webhookWorkers(request.app, request.options).get(request.identity.id)
  const cursor = live?.cursor ?? decodePreparedCursor(request.prepared)
  const record = existing
    ? refreshWebhookSubscriptionRecord(existing, request, refreshBefore, now)
    : newWebhookSubscriptionRecord(request, refreshBefore, now)
  return {
    ...request,
    existing,
    live,
    record,
    refreshBefore,
    cursor,
    responseCursor: cursor,
    responseTruncated: !live && request.prepared.cursorExpired,
    activePrimed: false,
    awaitInitialForSafeCursor: false,
    lifecycleSubscribed: false
  }
}

function assertWebhookSubscriptionOwner(
  existing: McpWebhookSubscriptionRecord | null,
  request: WebhookSubscriptionRequest
): void {
  if (!existing) return
  const valid =
    existing.key === request.identity.key &&
    existing.id === request.identity.id &&
    existing.principal === request.principal &&
    existing.url === request.delivery.url &&
    existing.name === request.prepared.request.name &&
    canonicalJson(existing.arguments) === canonicalJson(request.prepared.request.arguments) &&
    existing.variant === request.prepared.variant
  if (!valid) throw internalError('Webhook provider returned an invalid subscription owner')
}

function refreshWebhookSubscriptionRecord(
  existing: McpWebhookSubscriptionRecord,
  request: WebhookSubscriptionRequest,
  refreshBefore: string | null,
  now: Date
): McpWebhookSubscriptionRecord {
  const rotated =
    existing.secret === request.delivery.secret
      ? {}
      : {
          previousSecret: existing.secret,
          previousSecretExpiresAt: Date.now() + request.webhook.secretRotationGraceMs
        }
  return {
    ...existing,
    maxAgeMs: request.prepared.request.maxAgeMs,
    secret: request.delivery.secret,
    ...rotated,
    refreshBefore,
    active: true,
    updatedAt: now.toISOString(),
    deliveryStatus: existing.deliveryStatus
      ? { ...existing.deliveryStatus, active: true }
      : undefined
  }
}

function newWebhookSubscriptionRecord(
  request: WebhookSubscriptionRequest,
  refreshBefore: string | null,
  now: Date
): McpWebhookSubscriptionRecord {
  return {
    key: request.identity.key,
    id: request.identity.id,
    principal: request.principal,
    name: request.prepared.request.name,
    arguments: structuredClone(request.prepared.request.arguments),
    maxAgeMs: request.prepared.request.maxAgeMs,
    url: request.delivery.url,
    secret: request.delivery.secret,
    refreshBefore,
    verified: false,
    active: true,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    variant: request.prepared.variant
  }
}

async function verifySubscriptionEndpoint(flow: WebhookSubscriptionFlow): Promise<void> {
  try {
    await verifyWebhookEndpoint(flow.record, flow.context, flow.webhook, {
      app: flow.app,
      options: flow.options
    })
  } catch (error) {
    const reason =
      error instanceof McpWebhookVerificationError || error instanceof McpWebhookNetworkError
        ? error.reason
        : 'connection_refused'
    throw new McpEventProtocolError(-32015, 'CallbackEndpointError', { reason })
  }
  flow.record.verified = true
}

async function primeLiveWebhook(flow: WebhookSubscriptionFlow): Promise<void> {
  if (!flow.live || flow.live.terminal) return
  const safeCursor = flow.live.cursor
  const result = await pollSource(
    flow.prepared.source,
    { ...flow.prepared.request, cursor: safeCursor },
    flow.context,
    flow.options
  )
  applyWebhookInitialResult(flow, result, safeCursor, false, false)
  flow.activePrimed = true
}

function applyWebhookInitialResult(
  flow: WebhookSubscriptionFlow,
  result: McpEventPollResult,
  safeCursor: string | null,
  initial: boolean,
  cursorExpired: boolean
): void {
  if (result.terminated) throw eventError(result.terminated)
  flow.responseTruncated = cursorExpired || (result.truncated ?? false)
  if (initial || result.events.length === 0) {
    flow.responseCursor = result.cursor
    flow.cursor = result.cursor
    flow.initialResult = undefined
    return
  }
  flow.responseCursor = safeCursor
  flow.cursor = safeCursor
  flow.awaitInitialForSafeCursor = (result.truncated ?? false) && result.events.length > 0
  result.truncated = false
  flow.initialResult = result
}

async function beginWebhookRefresh(flow: WebhookSubscriptionFlow): Promise<void> {
  if (!flow.live) return
  flow.live.refreshGate = new Promise<void>((resolve) => {
    flow.releaseRefresh = resolve
  })
  try {
    await flow.live.persisting
  } catch (error) {
    flow.live.refreshGate = undefined
    flow.releaseRefresh?.()
    throw error
  }
}

async function storeWebhookSubscription(flow: WebhookSubscriptionFlow): Promise<void> {
  try {
    const stored = await flow.webhook.provider.upsert(flow.record, {
      maxSubscriptionsPerPrincipal: flow.webhook.maxSubscriptionsPerPrincipal
    })
    if ('limitExceeded' in stored)
      throw new McpEventProtocolError(-32013, 'ResourceExhausted', {
        limit: 'subscriptions',
        max: flow.webhook.maxSubscriptionsPerPrincipal
      })
    assertStoredWebhookSubscription(stored.record, flow.record)
    flow.record = stored.record
  } catch (error) {
    if (flow.live) flow.live.refreshGate = undefined
    flow.releaseRefresh?.()
    throw error
  }
}

function assertStoredWebhookSubscription(
  stored: McpWebhookSubscriptionRecord,
  expected: McpWebhookSubscriptionRecord
): void {
  const valid =
    stored.key === expected.key &&
    stored.id === expected.id &&
    stored.principal === expected.principal &&
    stored.url === expected.url &&
    stored.name === expected.name &&
    stored.variant === expected.variant &&
    stored.maxAgeMs === expected.maxAgeMs &&
    canonicalJson(stored.arguments) === canonicalJson(expected.arguments)
  if (!valid) throw internalError('Webhook provider changed subscription ownership')
}

async function finishWebhookRefresh(flow: WebhookSubscriptionFlow): Promise<void> {
  if (!flow.live) return
  flow.live.abort.abort('Webhook subscription refreshed')
  flow.releaseRefresh?.()
  await flow.live.done
  if (!flow.activePrimed) {
    flow.cursor = flow.live.cursor
    flow.responseCursor = flow.cursor
  }
  if (flow.live.terminal && flow.activePrimed) resetTerminatedWebhookRefresh(flow)
}

function resetTerminatedWebhookRefresh(flow: WebhookSubscriptionFlow): void {
  flow.activePrimed = false
  flow.initialResult = undefined
  flow.awaitInitialForSafeCursor = false
  flow.cursor = decodePreparedCursor(flow.prepared)
  flow.responseCursor = flow.cursor
  flow.responseTruncated = flow.prepared.cursorExpired
}

async function ensureWebhookWorker(flow: WebhookSubscriptionFlow): Promise<void> {
  if (webhookWorkers(flow.app, flow.options).has(flow.record.id)) return
  const epoch = nextWebhookLifecycleEpoch(flow.app, flow.options, flow.record.id)
  await unsubscribeTerminatedWebhook(flow)
  try {
    await initializeWebhookLifecycle(flow)
  } catch (error) {
    await rollbackWebhookLifecycle(flow, epoch)
    if (error instanceof McpEventProtocolError) throw error
    throw internalError('Event subscription setup failed')
  }
  const worker = startWebhookWorker(
    flow.app,
    flow.record,
    flow.cursor,
    flow.context,
    flow.prepared.source.definition,
    epoch,
    flow.options,
    flow.initialResult
  )
  if (flow.awaitInitialForSafeCursor) {
    await worker.initialProcessed
    flow.responseCursor = worker.cursor
  }
}

async function unsubscribeTerminatedWebhook(flow: WebhookSubscriptionFlow): Promise<void> {
  if (!flow.live?.terminal) return
  try {
    await flow.live.definition.onUnsubscribe?.(
      flow.record.arguments,
      flow.record.id,
      flow.live.context
    )
  } catch {
    // A completed terminal lifecycle does not prevent a new explicit subscription.
  }
}

async function initializeWebhookLifecycle(flow: WebhookSubscriptionFlow): Promise<void> {
  if (flow.live && !flow.live.terminal) return
  await flow.prepared.source.definition.onSubscribe?.(
    flow.record.arguments,
    flow.record.id,
    flow.context
  )
  flow.lifecycleSubscribed = true
  const result = await pollSource(
    flow.prepared.source,
    flow.prepared.request,
    flow.context,
    flow.options
  )
  applyWebhookInitialResult(
    flow,
    result,
    flow.prepared.request.cursor,
    flow.prepared.initial,
    flow.prepared.cursorExpired
  )
}

async function rollbackWebhookLifecycle(
  flow: WebhookSubscriptionFlow,
  epoch: bigint
): Promise<void> {
  await flow.webhook.provider.delete(flow.record.key)
  if (flow.lifecycleSubscribed)
    try {
      await flow.prepared.source.definition.onUnsubscribe?.(
        flow.record.arguments,
        flow.record.id,
        flow.context
      )
    } catch {
      // Failed setup remains failed after best-effort lifecycle cleanup.
    }
  retireWebhookLifecycleEpoch(flow.app, flow.options, flow.record.id, epoch)
}

function webhookSubscriptionResult(flow: WebhookSubscriptionFlow): Record<string, unknown> {
  return {
    id: flow.record.id,
    refreshBefore: flow.refreshBefore,
    cursor: encodeEventCursor(
      flow.responseCursor,
      flow.record.name,
      flow.record.arguments,
      flow.context.authorization,
      flow.record.variant,
      flow.config.cursor
    ),
    truncated: flow.responseTruncated,
    ...(flow.existing?.deliveryStatus ? { deliveryStatus: flow.record.deliveryStatus } : {})
  }
}

export async function unsubscribeEventsWebhook(
  app: AnyElysiaApp,
  params: Record<string, unknown>,
  options: NormalizedMcpPluginOptions,
  context: McpInvocationContext
): Promise<Record<string, never>> {
  const { config, webhook, principal } = webhookRequestEnvironment(options, context)
  const tuple = parseWebhookUnsubscribeTuple(params)
  const identity = deriveWebhookSubscriptionIdentity(
    principal,
    tuple.url,
    tuple.name,
    tuple.arguments,
    config.cursor.signingKey,
    eventVariantKey(context.meta)
  )
  const request: WebhookUnsubscribeRequest = {
    app,
    options,
    context,
    webhook,
    principal,
    tuple,
    identity
  }
  return withWebhookLifecycleLock(app, options, identity.id, () =>
    unsubscribeWebhookLocked(request)
  )
}

interface WebhookUnsubscribeTuple {
  name: string
  arguments: Record<string, unknown>
  url: string
}

interface WebhookUnsubscribeRequest {
  app: AnyElysiaApp
  options: NormalizedMcpPluginOptions
  context: McpInvocationContext
  webhook: NonNullable<NormalizedMcpEventsOptions['webhook']>
  principal: string
  tuple: WebhookUnsubscribeTuple
  identity: { key: string; id: string }
}

function parseWebhookUnsubscribeTuple(params: Record<string, unknown>): WebhookUnsubscribeTuple {
  if (typeof params.name !== 'string') throw invalidParams('Webhook unsubscribe tuple is invalid')
  const arguments_ = requiredWebhookTupleObject(params.arguments)
  const delivery = requiredWebhookTupleObject(params.delivery)
  const url = delivery.url
  if (typeof url !== 'string') throw invalidParams('Webhook unsubscribe tuple is invalid')
  try {
    parseWebhookUrl(url)
  } catch {
    throw invalidParams('Webhook URL is invalid')
  }
  return {
    name: params.name,
    arguments: arguments_,
    url
  }
}

function requiredWebhookTupleObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw invalidParams('Webhook unsubscribe tuple is invalid')
  return value as Record<string, unknown>
}

function webhookRequestEnvironment(
  options: NormalizedMcpPluginOptions,
  context: McpInvocationContext
): {
  config: NormalizedMcpEventsOptions
  webhook: NonNullable<NormalizedMcpEventsOptions['webhook']>
  principal: string
} {
  const config = eventOptions(options)
  const webhook = config.webhook
  if (!webhook) throw unsupported('deliveryMode', 'webhook')
  const principal = eventPrincipalKey(context.authorization)
  if (!principal) throw forbidden()
  return { config, webhook, principal }
}

async function unsubscribeWebhookLocked(
  request: WebhookUnsubscribeRequest
): Promise<Record<string, never>> {
  const record = await request.webhook.provider.get(request.identity.key)
  assertUnsubscribeRecord(record, request)
  const worker = webhookWorkers(request.app, request.options).get(record.id)
  const definition = worker?.definition
  const teardownContext = worker?.context ?? request.context
  const epoch = nextWebhookLifecycleEpoch(request.app, request.options, record.id)
  try {
    worker?.abort.abort('Webhook subscription removed')
    await worker?.done
    webhookWorkers(request.app, request.options).delete(record.id)
    await deleteWebhookSubscription(request, record, definition, teardownContext)
  } finally {
    retireWebhookLifecycleEpoch(request.app, request.options, record.id, epoch)
  }
  return {}
}

function assertUnsubscribeRecord(
  record: McpWebhookSubscriptionRecord | null,
  request: WebhookUnsubscribeRequest
): asserts record is McpWebhookSubscriptionRecord {
  const valid =
    !!record &&
    record.key === request.identity.key &&
    record.id === request.identity.id &&
    record.principal === request.principal &&
    record.url === request.tuple.url &&
    record.name === request.tuple.name &&
    record.variant === eventVariantKey(request.context.meta) &&
    canonicalJson(record.arguments) === canonicalJson(request.tuple.arguments)
  if (!valid) throw new McpEventProtocolError(-32011, 'NotFound', { kind: 'subscription' })
}

async function deleteWebhookSubscription(
  request: WebhookUnsubscribeRequest,
  record: McpWebhookSubscriptionRecord,
  definition: McpEventDefinition | undefined,
  context: McpInvocationContext
): Promise<void> {
  try {
    await request.webhook.provider.delete(record.key)
  } finally {
    try {
      const current =
        definition ??
        (await resolveEventSource(request.app, record.name, request.context, request.options))
          .definition
      await current.onUnsubscribe?.(record.arguments, record.id, context)
    } catch {
      // Removal is complete even when the event type no longer exists.
    }
  }
}

export function recoverWebhookSubscriptions(
  app: AnyElysiaApp,
  options: NormalizedMcpPluginOptions
): void {
  const config = options.extensions.events
  const webhook = config?.webhook
  if (!webhook) return
  queueMicrotask(() => {
    void recoverDurableWebhookSubscriptions(app, options, config, webhook).catch(() => {
      // Recovery failures remain isolated from plugin installation.
    })
  })
}

async function recoverDurableWebhookSubscriptions(
  app: AnyElysiaApp,
  options: NormalizedMcpPluginOptions,
  config: NormalizedMcpEventsOptions,
  webhook: NonNullable<NormalizedMcpEventsOptions['webhook']>
): Promise<void> {
  const records = await webhook.provider.list()
  if (!records) return
  for await (const record of records)
    await recoverDurableWebhookRecord(app, options, config, record)
}

async function recoverDurableWebhookRecord(
  app: AnyElysiaApp,
  options: NormalizedMcpPluginOptions,
  config: NormalizedMcpEventsOptions,
  record: McpWebhookSubscriptionRecord
): Promise<void> {
  try {
    const identity = validateRecoveredWebhookRecord(record, config)
    if (!identity) return
    await withWebhookLifecycleLock(app, options, record.id, () =>
      recoverWebhookLocked(app, options, record, identity)
    )
  } catch {
    // One corrupt or unauthorized durable record must not block recovery of others.
  }
}

function validateRecoveredWebhookRecord(
  record: McpWebhookSubscriptionRecord,
  config: NormalizedMcpEventsOptions
): { key: string; id: string } | null {
  if (!record.verified || !record.active) return null
  if (
    record.maxAgeMs !== undefined &&
    (!Number.isSafeInteger(record.maxAgeMs) || record.maxAgeMs < 0)
  )
    return null
  parseWebhookUrl(record.url)
  assertWebhookSecret(record.secret)
  const identity = deriveWebhookSubscriptionIdentity(
    record.principal,
    record.url,
    record.name,
    record.arguments,
    config.cursor.signingKey,
    record.variant
  )
  return identity.key === record.key && identity.id === record.id ? identity : null
}

async function recoverWebhookLocked(
  app: AnyElysiaApp,
  options: NormalizedMcpPluginOptions,
  record: McpWebhookSubscriptionRecord,
  identity: { key: string; id: string }
): Promise<void> {
  const webhook = eventOptions(options).webhook
  if (!webhook) return
  const current = await webhook.provider.get(record.key)
  if (!validCurrentRecoveryRecord(current, record, identity)) return
  if (webhookWorkers(app, options).has(current.id)) return
  const authorization = await webhook.provider.authorizeDelivery(current)
  if (!authorization || eventPrincipalKey(authorization) !== current.principal) return
  const context = recoveredWebhookContext(current, authorization)
  const source = await resolveEventSource(app, current.name, context, options)
  await authorizeEvent(source.definition, current.arguments, context)
  await source.definition.onSubscribe?.(current.arguments, current.id, context)
  const epoch = nextWebhookLifecycleEpoch(app, options, current.id)
  startWebhookWorker(app, current, null, context, source.definition, epoch, options)
}

function validCurrentRecoveryRecord(
  current: McpWebhookSubscriptionRecord | null,
  original: McpWebhookSubscriptionRecord,
  identity: { key: string; id: string }
): current is McpWebhookSubscriptionRecord {
  return (
    !!current?.verified &&
    current.active &&
    current.key === identity.key &&
    current.id === identity.id &&
    current.principal === original.principal &&
    current.variant === original.variant
  )
}

function recoveredWebhookContext(
  record: McpWebhookSubscriptionRecord,
  authorization: NonNullable<McpInvocationContext['authorization']>
): McpInvocationContext {
  return {
    request: new Request('https://localhost/mcp'),
    protocolVersion: LEGACY_PROTOCOL_VERSION,
    authorization,
    meta: record.variant ? { 'io.modelcontextprotocol/server-variant': record.variant } : undefined
  }
}

function startWebhookWorker(
  app: AnyElysiaApp,
  initialRecord: McpWebhookSubscriptionRecord,
  initialCursor: string | null,
  initialContext: McpInvocationContext,
  initialDefinition: McpEventDefinition,
  epoch: bigint,
  options: NormalizedMcpPluginOptions,
  preparedInitialResult?: McpEventPollResult
): WebhookWorkerState {
  const config = eventOptions(options)
  const webhook = config.webhook
  if (!webhook) throw internalError('Webhook delivery is unavailable')
  const workers = webhookWorkers(app, options)
  workers.get(initialRecord.id)?.abort.abort('Webhook subscription refreshed')
  const abort = new AbortController()
  let resolveInitial = () => {}
  let rejectInitial = (_error: unknown) => {}
  const initialSettled = preparedInitialResult === undefined
  const initialProcessed = initialSettled
    ? Promise.resolve()
    : new Promise<void>((resolve, reject) => {
        resolveInitial = resolve
        rejectInitial = reject
      })
  void initialProcessed.catch(() => {
    // Callers may intentionally continue after an asynchronous prepared batch failure.
  })
  const state: WebhookWorkerState = {
    abort,
    cursor: initialCursor,
    context: initialContext,
    definition: initialDefinition,
    done: Promise.resolve(),
    initialProcessed,
    epoch,
    terminal: false
  }
  workers.set(initialRecord.id, state)
  const worker: WebhookWorkerLoop = {
    app,
    options,
    config,
    webhook,
    workers,
    state,
    record: initialRecord,
    initializing: initialCursor === null && !preparedInitialResult,
    initialResult: preparedInitialResult,
    initialSettled,
    resolveInitial,
    rejectInitial,
    terminalCleanup: false
  }
  state.done = runWebhookWorker(worker)
  return state
}

interface WebhookWorkerLoop {
  app: AnyElysiaApp
  options: NormalizedMcpPluginOptions
  config: NormalizedMcpEventsOptions
  webhook: NonNullable<NormalizedMcpEventsOptions['webhook']>
  workers: Map<string, WebhookWorkerState>
  state: WebhookWorkerState
  record: McpWebhookSubscriptionRecord
  initializing: boolean
  initialResult?: McpEventPollResult
  initialSettled: boolean
  resolveInitial: () => void
  rejectInitial: (error: unknown) => void
  originalDescriptor?: McpEventDescriptor
  terminalCleanup: boolean
}

async function runWebhookWorker(worker: WebhookWorkerLoop): Promise<void> {
  try {
    while (!worker.state.abort.signal.aborted) {
      const cycle = await runWebhookWorkerCycle(worker)
      if (cycle === 'terminal') break
      await abortableDelay(worker.config.pollIntervalMs, worker.state.abort.signal)
    }
  } catch {
    rejectUnsettledWebhookInitial(worker, internalError('UpstreamError'))
    if (!worker.state.abort.signal.aborted) markWebhookWorkerTerminal(worker)
  } finally {
    rejectUnsettledWebhookInitial(worker, internalError('UpstreamError'))
    if (worker.workers.get(worker.record.id)?.abort === worker.state.abort)
      worker.workers.delete(worker.record.id)
    if (worker.terminalCleanup) scheduleTerminalWebhookCleanup(worker)
  }
}

async function runWebhookWorkerCycle(worker: WebhookWorkerLoop): Promise<'continue' | 'terminal'> {
  if (webhookRecordExpired(worker.record)) {
    markWebhookWorkerTerminal(worker)
    return 'terminal'
  }
  const context = await authorizeWebhookWorkerCycle(worker)
  if (!context) return 'terminal'
  const source = await resolveWebhookWorkerSource(worker, context)
  if (!source) return 'terminal'
  if (!(await acceptWebhookWorkerDescriptor(worker, source))) return 'terminal'
  worker.state.definition = source.definition
  worker.state.context = { ...context, signal: undefined }
  return processWebhookWorkerBatchSafely(worker, source, context)
}

function webhookRecordExpired(record: McpWebhookSubscriptionRecord): boolean {
  return record.refreshBefore !== null && Date.parse(record.refreshBefore) <= Date.now()
}

async function authorizeWebhookWorkerCycle(
  worker: WebhookWorkerLoop
): Promise<McpInvocationContext | null> {
  const authorization = await worker.webhook.provider.authorizeDelivery(worker.record)
  if (!authorization || eventPrincipalKey(authorization) !== worker.record.principal) {
    await terminateWebhook(
      worker.record,
      forbiddenError(),
      worker.webhook,
      worker.state.abort.signal
    )
    markWebhookWorkerTerminal(worker)
    return null
  }
  return {
    ...worker.state.context,
    signal: worker.state.abort.signal,
    authorization,
    meta: worker.record.variant
      ? {
          ...worker.state.context.meta,
          'io.modelcontextprotocol/server-variant': worker.record.variant
        }
      : worker.state.context.meta
  }
}

async function resolveWebhookWorkerSource(
  worker: WebhookWorkerLoop,
  context: McpInvocationContext
): Promise<EventSource | null> {
  try {
    const source = await resolveEventSource(worker.app, worker.record.name, context, worker.options)
    await authorizeEvent(source.definition, worker.record.arguments, context)
    return source
  } catch (error) {
    await terminateWebhook(
      worker.record,
      terminationForResolution(error),
      worker.webhook,
      worker.state.abort.signal
    )
    markWebhookWorkerTerminal(worker)
    return null
  }
}

async function acceptWebhookWorkerDescriptor(
  worker: WebhookWorkerLoop,
  source: EventSource
): Promise<boolean> {
  const current = eventDescriptor(source.definition)
  if (!worker.originalDescriptor) {
    worker.originalDescriptor = current
    return true
  }
  const schemaChange = incompatibleEventSchema(worker.originalDescriptor, current)
  const deliveryRemoved = worker.originalDescriptor.delivery.some(
    (mode) => !current.delivery.includes(mode)
  )
  if (!schemaChange && !deliveryRemoved) return true
  await terminateWebhook(
    worker.record,
    {
      code: -32014,
      message: 'Unsupported',
      data: { feature: schemaChange ?? 'deliveryMode', reason: 'schema_changed' }
    },
    worker.webhook,
    worker.state.abort.signal
  )
  markWebhookWorkerTerminal(worker)
  return false
}

async function processWebhookWorkerBatchSafely(
  worker: WebhookWorkerLoop,
  source: EventSource,
  context: McpInvocationContext
): Promise<'continue' | 'terminal'> {
  const processingPreparedResult = worker.initialResult !== undefined
  try {
    const result = await webhookWorkerPollResult(worker, source, context)
    if (result.terminated) {
      rejectPreparedWebhookInitial(worker, processingPreparedResult, eventError(result.terminated))
      await terminateWebhook(
        worker.record,
        result.terminated,
        worker.webhook,
        worker.state.abort.signal
      )
      markWebhookWorkerTerminal(worker)
      return 'terminal'
    }
    await processWebhookPollResult(worker, source, context, result)
    resolvePreparedWebhookInitial(worker, processingPreparedResult)
    if (worker.state.abort.signal.aborted) return 'terminal'
    await worker.state.refreshGate
    if (worker.state.abort.signal.aborted) return 'terminal'
    await persistWebhookWorkerRecord(worker)
    return 'continue'
  } catch (error) {
    rejectPreparedWebhookInitial(worker, processingPreparedResult, error)
    return handleWebhookWorkerBatchError(worker, error)
  }
}

async function webhookWorkerPollResult(
  worker: WebhookWorkerLoop,
  source: EventSource,
  context: McpInvocationContext
): Promise<McpEventPollResult> {
  const prepared = worker.initialResult
  worker.initialResult = undefined
  return (
    prepared ??
    pollSource(
      source,
      {
        name: worker.record.name,
        arguments: worker.record.arguments,
        cursor: worker.state.cursor,
        maxAgeMs: Math.min(
          worker.record.maxAgeMs ?? worker.config.maxAgeMs,
          worker.config.maxAgeMs
        ),
        maxEvents: worker.config.maxEvents
      },
      context,
      worker.options
    )
  )
}

async function processWebhookPollResult(
  worker: WebhookWorkerLoop,
  source: EventSource,
  context: McpInvocationContext,
  result: McpEventPollResult
): Promise<void> {
  suppressInitialWebhookReplay(worker, result)
  const delayedGap = (result.truncated ?? false) && result.events.length > 0
  if (result.truncated && !delayedGap) {
    await deliverWebhookGap(worker, result.cursor, context)
    worker.state.cursor = result.cursor
  }
  for (const occurrence of result.events)
    await deliverWebhookOccurrence(worker, source, context, occurrence, result.cursor !== null)
  worker.state.cursor = result.cursor
  if (delayedGap) await deliverWebhookGap(worker, worker.state.cursor, context)
}

function suppressInitialWebhookReplay(worker: WebhookWorkerLoop, result: McpEventPollResult): void {
  if (!worker.initializing) return
  result.events = []
  result.hasMore = false
  result.truncated = false
  worker.initializing = false
}

async function deliverWebhookGap(
  worker: WebhookWorkerLoop,
  cursor: string | null,
  context: McpInvocationContext
): Promise<void> {
  const fresh = encodeEventCursor(
    cursor,
    worker.record.name,
    worker.record.arguments,
    context.authorization,
    worker.record.variant,
    worker.config.cursor
  )
  await deliverWebhook(
    worker.record,
    { type: 'gap', cursor: fresh },
    webhookControlMessageId('gap'),
    worker.webhook,
    worker.state.abort.signal
  )
}

async function deliverWebhookOccurrence(
  worker: WebhookWorkerLoop,
  source: EventSource,
  context: McpInvocationContext,
  occurrence: McpEventOccurrence,
  replayable: boolean
): Promise<void> {
  if (replayable && occurrence.cursor == null)
    throw internalError('Replayable webhook events require per-event cursors')
  const safeCursor = encodeEventCursor(
    worker.state.cursor,
    worker.record.name,
    worker.record.arguments,
    context.authorization,
    worker.record.variant,
    worker.config.cursor
  )
  const delivery = await deliverWebhook(
    worker.record,
    { ...occurrence, cursor: safeCursor },
    occurrence.eventId,
    worker.webhook,
    worker.state.abort.signal,
    () => authorizeWebhookDeliveryAttempt(worker, source, context)
  )
  worker.state.cursor = occurrence.cursor ?? null
  worker.record = updateDeliveryStatus(worker.record, delivery.lastError)
}

async function authorizeWebhookDeliveryAttempt(
  worker: WebhookWorkerLoop,
  source: EventSource,
  context: McpInvocationContext
): Promise<boolean> {
  const authorization = await worker.webhook.provider.authorizeDelivery(worker.record)
  if (!authorization || eventPrincipalKey(authorization) !== worker.record.principal) return false
  return isEventAuthorizedForDelivery(source.definition, worker.record.arguments, {
    ...context,
    authorization
  })
}

async function persistWebhookWorkerRecord(worker: WebhookWorkerLoop): Promise<void> {
  const persisting = persistWebhookRecord(worker.record, worker.webhook)
  worker.state.persisting = persisting
  try {
    await persisting
  } finally {
    if (worker.state.persisting === persisting) worker.state.persisting = undefined
  }
}

async function handleWebhookWorkerBatchError(
  worker: WebhookWorkerLoop,
  error: unknown
): Promise<'continue' | 'terminal'> {
  if (worker.state.abort.signal.aborted) return 'terminal'
  if (error instanceof McpWebhookDeliveryRevokedError) {
    await terminateWebhook(
      worker.record,
      forbiddenError(),
      worker.webhook,
      worker.state.abort.signal
    )
    markWebhookWorkerTerminal(worker)
    return 'terminal'
  }
  if (error instanceof McpEventProtocolError && error.code === -32603) {
    await terminateWebhook(
      worker.record,
      { code: -32603, message: 'UpstreamError' },
      worker.webhook,
      worker.state.abort.signal
    )
    markWebhookWorkerTerminal(worker)
    return 'terminal'
  }
  return 'continue'
}

function resolvePreparedWebhookInitial(
  worker: WebhookWorkerLoop,
  processingPreparedResult: boolean
): void {
  if (!processingPreparedResult || worker.initialSettled) return
  worker.initialSettled = true
  worker.resolveInitial()
}

function rejectPreparedWebhookInitial(
  worker: WebhookWorkerLoop,
  processingPreparedResult: boolean,
  error: unknown
): void {
  if (!processingPreparedResult) return
  rejectUnsettledWebhookInitial(worker, error)
}

function rejectUnsettledWebhookInitial(worker: WebhookWorkerLoop, error: unknown): void {
  if (worker.initialSettled) return
  worker.initialSettled = true
  worker.rejectInitial(error)
}

function markWebhookWorkerTerminal(worker: WebhookWorkerLoop): void {
  worker.terminalCleanup = true
  worker.state.terminal = true
}

function scheduleTerminalWebhookCleanup(worker: WebhookWorkerLoop): void {
  scheduleWebhookTerminalCleanup(
    worker.app,
    worker.options,
    worker.record,
    worker.state,
    worker.webhook
  ).catch(() => {
    // Terminal cleanup failures remain isolated from request processing.
  })
}

async function isEventAuthorizedForDelivery(
  definition: McpEventDefinition,
  arguments_: Record<string, unknown>,
  context: McpInvocationContext
): Promise<boolean> {
  try {
    await authorizeEvent(definition, arguments_, context)
    return true
  } catch {
    return false
  }
}

function updateDeliveryStatus(
  record: McpWebhookSubscriptionRecord,
  error: McpWebhookDeliveryStatus['lastError']
): McpWebhookSubscriptionRecord {
  const now = new Date().toISOString()
  return {
    ...record,
    updatedAt: now,
    deliveryStatus: error
      ? {
          active: true,
          lastDeliveryAt: record.deliveryStatus?.lastDeliveryAt,
          lastError: error,
          failedSince: record.deliveryStatus?.failedSince ?? now
        }
      : { active: true, lastDeliveryAt: now, lastError: null }
  }
}

async function persistWebhookRecord(
  record: McpWebhookSubscriptionRecord,
  webhook: NonNullable<NormalizedMcpEventsOptions['webhook']>
): Promise<void> {
  const result = await webhook.provider.upsert(record, {
    maxSubscriptionsPerPrincipal: webhook.maxSubscriptionsPerPrincipal
  })
  if ('limitExceeded' in result) throw internalError('Webhook subscription quota changed')
}

async function renewPollLease(
  app: AnyElysiaApp,
  prepared: Awaited<ReturnType<typeof prepareEventRequest>>,
  context: McpInvocationContext,
  options: NormalizedMcpPluginOptions
): Promise<void> {
  const config = eventOptions(options)
  const key = canonicalJson([
    eventPrincipalKey(context.authorization) ?? null,
    prepared.variant ?? null,
    prepared.request.name,
    prepared.request.arguments
  ])
  const leases = eventRuntimeState(app, options).pollLeases
  const existing = leases.get(key)
  if (existing) clearTimeout(existing.timer)
  else
    await prepared.source.definition.onSubscribe?.(
      prepared.request.arguments,
      `poll_${deriveWebhookSubscriptionIdentity(
        eventPrincipalKey(context.authorization) ?? 'anonymous',
        prepared.variant ?? 'default',
        prepared.request.name,
        prepared.request.arguments,
        config.cursor.signingKey
      ).id.slice(4)}`,
      context
    )
  const definition = prepared.source.definition
  const timer = setTimeout(() => {
    leases?.delete(key)
    Promise.resolve(
      definition.onUnsubscribe?.(
        prepared.request.arguments,
        `poll_${deriveWebhookSubscriptionIdentity(
          eventPrincipalKey(context.authorization) ?? 'anonymous',
          prepared.variant ?? 'default',
          prepared.request.name,
          prepared.request.arguments,
          config.cursor.signingKey
        ).id.slice(4)}`,
        context
      )
    ).catch(() => {
      // Lease cleanup failures are isolated from future requests.
    })
  }, config.pollLeaseMs)
  timer.unref?.()
  leases.set(key, { timer, definition })
}

async function terminateWebhook(
  record: McpWebhookSubscriptionRecord,
  error: McpEventError,
  webhook: NonNullable<NormalizedMcpEventsOptions['webhook']>,
  signal: AbortSignal
): Promise<void> {
  try {
    await deliverWebhook(
      record,
      { type: 'terminated', error },
      webhookControlMessageId('terminated'),
      webhook,
      signal
    )
  } catch {}
}

async function prepareEventRequest(
  app: AnyElysiaApp,
  params: Record<string, unknown>,
  mode: 'poll' | 'push' | 'webhook',
  options: NormalizedMcpPluginOptions,
  context: McpInvocationContext
): Promise<{
  source: EventSource
  request: McpEventPollRequest
  initial: boolean
  cursorExpired: boolean
  variant?: string
}> {
  const config = eventOptions(options)
  await authorizeExtension(config, context)
  const parsed = parseEventRequestParameters(params, config)
  const source = await resolveEventSource(app, parsed.name, context, options)
  if (!source.definition.delivery.includes(mode)) throw unsupported('deliveryMode', mode)
  try {
    assertEventArguments(source.definition, parsed.arguments)
  } catch (error) {
    throw invalidParams(error instanceof Error ? error.message : 'Invalid event arguments')
  }
  await authorizeEvent(source.definition, parsed.arguments, context)
  const variant = eventVariantKey(context.meta)
  const decoded = decodeRequestCursor(params.cursor, parsed, context, variant, config)
  return {
    source,
    request: {
      name: parsed.name,
      arguments: structuredClone(parsed.arguments),
      cursor: decoded.cursor,
      maxAgeMs: parsed.maxAgeMs,
      maxEvents: parsed.maxEvents
    },
    initial: params.cursor === undefined || params.cursor === null || decoded.expired,
    cursorExpired: decoded.expired,
    variant
  }
}

interface ParsedEventRequest {
  name: string
  arguments: Record<string, unknown>
  maxEvents: number
  maxAgeMs: number
}

function parseEventRequestParameters(
  params: Record<string, unknown>,
  config: NormalizedMcpEventsOptions
): ParsedEventRequest {
  if (typeof params.name !== 'string' || params.name.length === 0)
    throw invalidParams('Event name is required')
  const arguments_ = params.arguments ?? {}
  if (!arguments_ || typeof arguments_ !== 'object' || Array.isArray(arguments_))
    throw invalidParams('Event arguments must be an object')
  return {
    name: params.name,
    arguments: arguments_ as Record<string, unknown>,
    maxEvents: boundedInteger(params.maxEvents, config.maxEvents, 1, 'Event maxEvents is invalid'),
    maxAgeMs: boundedInteger(params.maxAgeMs, config.maxAgeMs, 0, 'Event maxAgeMs is invalid')
  }
}

function boundedInteger(value: unknown, maximum: number, minimum: number, message: string): number {
  const selected = value ?? maximum
  if (!Number.isSafeInteger(selected) || Number(selected) < minimum || Number(selected) > maximum)
    throw invalidParams(message)
  return Number(selected)
}

function decodeRequestCursor(
  value: unknown,
  request: ParsedEventRequest,
  context: McpInvocationContext,
  variant: string | undefined,
  config: NormalizedMcpEventsOptions
): { cursor: string | null; expired: boolean } {
  try {
    const decoded = decodeEventCursor(
      value,
      request.name,
      request.arguments,
      context.authorization,
      variant,
      config.cursor
    )
    return { cursor: decoded.expired ? null : decoded.cursor, expired: decoded.expired }
  } catch {
    throw invalidParams('Invalid event cursor')
  }
}

async function resolveEventSource(
  app: AnyElysiaApp,
  name: string,
  context: McpInvocationContext,
  options: NormalizedMcpPluginOptions
): Promise<EventSource> {
  const local = getMcpRegistry(app, options).events?.get(name)
  if (local) return { definition: local.definition, registration: local }
  const definition = await eventOptions(options).provider?.get(name, context)
  if (!definition) throw new McpEventProtocolError(-32011, 'NotFound', { kind: 'event' })
  assertProviderDefinition(definition)
  if (definition.name !== name) throw internalError('Event provider returned the wrong event')
  return { definition }
}

async function pollSource(
  source: EventSource,
  request: McpEventPollRequest,
  context: McpInvocationContext,
  options: NormalizedMcpPluginOptions
): Promise<McpEventPollResult> {
  let result: McpEventPollResult
  try {
    if (source.registration) result = await source.registration.handler(request, context)
    else {
      const provider = eventOptions(options).provider
      if (!provider) throw internalError('Event provider is unavailable')
      result = await provider.poll(request, context)
    }
    assertEventPollResult(source.definition, result, request.maxEvents)
  } catch (error) {
    if (error instanceof McpEventProtocolError) throw error
    throw internalError('UpstreamError')
  }
  return structuredClone(result)
}

function serializePollResult(
  result: McpEventPollResult,
  prepared: Awaited<ReturnType<typeof prepareEventRequest>>,
  context: McpInvocationContext,
  options: NormalizedMcpPluginOptions,
  includeOccurrenceCursors: boolean
): Record<string, unknown> {
  return {
    events: result.events.map((event) => {
      const copy = structuredClone(event) as McpEventOccurrence
      if (!includeOccurrenceCursors) delete copy.cursor
      return copy
    }),
    cursor: encodeEventCursor(
      result.cursor,
      prepared.request.name,
      prepared.request.arguments,
      context.authorization,
      prepared.variant,
      eventOptions(options).cursor
    ),
    truncated: result.truncated ?? false,
    hasMore: result.hasMore ?? false,
    nextPollMs: result.nextPollMs ?? eventOptions(options).pollIntervalMs
  }
}

async function authorizeExtension(
  options: NormalizedMcpEventsOptions,
  context: McpInvocationContext
): Promise<void> {
  if (!hasScopes(options.authorization, context)) throw forbidden()
}

async function authorizeEvent(
  definition: McpEventDefinition,
  arguments_: Record<string, unknown>,
  context: McpInvocationContext
): Promise<void> {
  if (!hasScopes(definition.authorization, context)) throw forbidden()
  if (definition.authorize && !(await definition.authorize(arguments_, context))) throw forbidden()
  const expiresAt = context.authorization?.principal.expiresAt
  if (expiresAt !== undefined && expiresAt <= Math.floor(Date.now() / 1000)) throw forbidden()
}

function hasScopes(
  requirement: { requiredScopes?: readonly string[] } | undefined,
  context: McpInvocationContext
): boolean {
  return (
    !requirement?.requiredScopes?.length ||
    (!!context.authorization &&
      missingRequiredScopes(requirement.requiredScopes, context.authorization.scopes).length === 0)
  )
}

function assertProviderDefinition(definition: McpEventDefinition): void {
  try {
    assertEventDefinition(definition)
  } catch {
    throw internalError('Event provider returned an invalid definition')
  }
}

function eventOptions(options: NormalizedMcpPluginOptions): NormalizedMcpEventsOptions {
  const config = options.extensions.events
  if (!config)
    throw new McpEventProtocolError(-32601, 'Events extension is not enabled', undefined, 404)
  return config
}

function configuredEventDescriptor(
  definition: McpEventDefinition,
  options: NormalizedMcpEventsOptions
): McpEventDescriptor | undefined {
  const descriptor = eventDescriptor(definition)
  descriptor.delivery = descriptor.delivery.filter(
    (mode) => mode !== 'webhook' || options.webhook !== undefined
  )
  return descriptor.delivery.length > 0 ? descriptor : undefined
}

async function scheduleWebhookTerminalCleanup(
  app: AnyElysiaApp,
  options: NormalizedMcpPluginOptions,
  record: McpWebhookSubscriptionRecord,
  state: WebhookWorkerState,
  webhook: NonNullable<NormalizedMcpEventsOptions['webhook']>
): Promise<void> {
  await withWebhookLifecycleLock(app, options, record.id, async () => {
    if (webhookLifecycleEpoch(app, options, record.id) !== state.epoch) return
    if (webhookWorkers(app, options).has(record.id)) return
    const terminalEpoch = nextWebhookLifecycleEpoch(app, options, record.id)
    try {
      await webhook.provider.delete(record.key)
    } finally {
      try {
        await state.definition.onUnsubscribe?.(record.arguments, record.id, state.context)
      } catch {
        // Provider state remains terminal when lifecycle cleanup fails.
      } finally {
        retireWebhookLifecycleEpoch(app, options, record.id, terminalEpoch)
      }
    }
  })
}

function webhookGrant(
  value: unknown,
  options: NonNullable<NormalizedMcpEventsOptions['webhook']>
): number | null {
  if (value === null) return options.allowNoExpiry ? null : options.maxTtlMs
  if (value !== undefined && (!Number.isSafeInteger(value) || Number(value) <= 0))
    throw invalidParams('Webhook ttlMs is invalid')
  const suggested = value === undefined ? options.defaultTtlMs : Number(value)
  return Math.max(options.minTtlMs, Math.min(options.maxTtlMs, suggested))
}

function decodePreparedCursor(
  prepared: Awaited<ReturnType<typeof prepareEventRequest>>
): string | null {
  return prepared.request.cursor
}

function eventNotification(type: string, params: Record<string, unknown>) {
  return { jsonrpc: '2.0', method: `notifications/events/${type}`, params }
}

function terminationForResolution(error: unknown): McpEventError {
  if (error instanceof McpEventProtocolError) {
    if (error.code === -32012) return forbiddenError()
    if (error.code === -32011) return { code: -32011, message: 'NotFound', data: { kind: 'event' } }
  }
  return { code: -32603, message: 'UpstreamError' }
}

function forbidden(): McpEventProtocolError {
  return new McpEventProtocolError(-32012, 'Forbidden')
}

function forbiddenError(): McpEventError {
  return { code: -32012, message: 'Forbidden', data: { reason: 'Access revoked' } }
}

function unsupported(feature: string, value: string): McpEventProtocolError {
  return new McpEventProtocolError(-32014, 'Unsupported', { feature, value })
}

function invalidParams(message: string): McpEventProtocolError {
  return new McpEventProtocolError(-32602, 'InvalidParams', { reason: message })
}

function internalError(message: string): McpEventProtocolError {
  return new McpEventProtocolError(-32603, message)
}

function eventError(error: McpEventError): McpEventProtocolError {
  return new McpEventProtocolError(error.code, error.message, error.data)
}
