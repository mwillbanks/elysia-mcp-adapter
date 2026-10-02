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
import { McpWebhookNetworkError, parseWebhookUrl } from './network.js'
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

const EVENT_RUNTIME_STATES = new WeakMap<
  AnyElysiaApp,
  WeakMap<NormalizedMcpPluginOptions, EventRuntimeState>
>()

interface EventRuntimeState {
  workers: Map<string, WebhookWorkerState>
  lifecycleLocks: Map<string, Promise<void>>
  lifecycleEpochs: Map<string, bigint>
  lifecycleCounter: bigint
  pollLeases: Map<string, { timer: ReturnType<typeof setTimeout>; definition: McpEventDefinition }>
}

interface EventSource {
  definition: McpEventDefinition
  registration?: McpEventRegistration
}

interface WebhookWorkerState {
  abort: AbortController
  cursor: string | null
  context: McpInvocationContext
  definition: McpEventDefinition
  done: Promise<void>
  initialProcessed: Promise<void>
  epoch: bigint
  terminal: boolean
  persisting?: Promise<void>
  refreshGate?: Promise<void>
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
  const visibleLocal: McpEventDefinition[] = []
  for (const registration of local)
    if (hasScopes(registration.definition.authorization, context))
      visibleLocal.push(registration.definition)
  const pageSize = config.pagination?.pageSize
  const output: McpEventDescriptor[] = []
  let nextOffset: number | undefined
  if (offset < visibleLocal.length) {
    const end = Math.min(visibleLocal.length, offset + (pageSize ?? visibleLocal.length))
    output.push(
      ...visibleLocal
        .slice(offset, end)
        .map((definition) => configuredEventDescriptor(definition, config))
        .filter((definition): definition is McpEventDescriptor => definition !== undefined)
    )
    if (end < visibleLocal.length || config.provider) nextOffset = end
  } else if (config.provider) {
    const providerOffset = offset - visibleLocal.length
    const page = await config.provider.list(
      { offset: providerOffset, limit: pageSize },
      { ...context, request }
    )
    if (
      !page ||
      !Array.isArray(page.events) ||
      (page.hasMore !== undefined && typeof page.hasMore !== 'boolean') ||
      (pageSize !== undefined && page.events.length > pageSize) ||
      (page.hasMore && page.events.length === 0)
    )
      throw internalError('Event provider returned an invalid page')
    for (const definition of page.events) {
      assertProviderDefinition(definition)
      const localDefinition = local.find(
        ({ definition: item }) => item.name === definition.name
      )?.definition
      if (localDefinition) {
        if (
          canonicalJson(eventDescriptor(localDefinition)) !==
          canonicalJson(eventDescriptor(definition))
        )
          throw internalError('Event provider conflicts with an explicit event')
        continue
      }
      const descriptor = configuredEventDescriptor(definition, config)
      if (descriptor && hasScopes(definition.authorization, context)) output.push(descriptor)
    }
    if (page.hasMore) nextOffset = visibleLocal.length + providerOffset + page.events.length
  } else if (offset > visibleLocal.length) {
    throw invalidParams('Invalid events pagination cursor')
  }
  return {
    events: output,
    ...(nextOffset !== undefined && config.pagination
      ? {
          nextCursor: encodeCursor(
            'events/list',
            nextOffset,
            params,
            context,
            options,
            config.pagination
          )
        }
      : {})
  }
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
  let cleanup: (() => Promise<void>) | undefined
  let cleaned = false
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (value: unknown) =>
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`))
      const meta = { 'io.modelcontextprotocol/subscriptionId': parentId }
      let cursor = prepared.initial || initial.truncated ? initial.cursor : prepared.request.cursor
      let heartbeat: ReturnType<typeof setInterval> | undefined
      const encodedCursor = () =>
        encodeEventCursor(
          cursor,
          prepared.request.name,
          prepared.request.arguments,
          context.authorization,
          prepared.variant,
          eventOptions(options).cursor
        )
      const sendOccurrence = (occurrence: McpEventOccurrence, replayable: boolean) => {
        if (replayable && occurrence.cursor == null)
          throw internalError('Replayable push events require per-event cursors')
        cursor = occurrence.cursor ?? null
        send(
          eventNotification('event', {
            ...occurrence,
            cursor: encodedCursor(),
            _meta: { ...occurrence._meta, ...meta }
          })
        )
      }
      cleanup = async () => {
        if (cleaned) return
        cleaned = true
        if (heartbeat) clearInterval(heartbeat)
        abort.abort('Event stream closed')
        context.signal?.removeEventListener('abort', relay)
        await prepared.source.definition.onUnsubscribe?.(
          prepared.request.arguments,
          String(parentId),
          context
        )
      }
      void (async () => {
        let serverClosed = false
        try {
          send({
            jsonrpc: '2.0',
            method: 'notifications/events/active',
            params: {
              cursor: encodedCursor(),
              truncated: initial.truncated ?? false,
              _meta: meta
            }
          })
          for (const occurrence of initial.events)
            sendOccurrence(occurrence, initial.cursor !== null)
          if (initial.events.length === 0) cursor = initial.cursor
          heartbeat = setInterval(() => {
            if (abort.signal.aborted) return
            try {
              send(
                eventNotification('heartbeat', {
                  cursor: encodedCursor(),
                  _meta: meta
                })
              )
            } catch {
              abort.abort('Event stream heartbeat failed')
            }
          }, eventOptions(options).heartbeatMs)
          heartbeat.unref?.()
          let nextPollMs = initial.nextPollMs ?? eventOptions(options).pollIntervalMs
          while (!abort.signal.aborted) {
            const delay = Math.min(nextPollMs, eventOptions(options).heartbeatMs)
            await abortableDelay(delay, abort.signal)
            let current: EventSource
            try {
              current = await resolveEventSource(app, prepared.request.name, context, options)
              await authorizeEvent(current.definition, prepared.request.arguments, context)
            } catch (error) {
              const termination = terminationForResolution(error)
              send(eventNotification('terminated', { error: termination, _meta: meta }))
              serverClosed = true
              break
            }
            const schemaChange = incompatibleEventSchema(
              originalDescriptor,
              eventDescriptor(current.definition)
            )
            if (
              originalDescriptor.delivery.some(
                (mode) => !current.definition.delivery.includes(mode)
              ) ||
              schemaChange
            ) {
              send(
                eventNotification('terminated', {
                  error: {
                    code: -32014,
                    message: 'Unsupported',
                    data: { feature: schemaChange ?? 'deliveryMode', reason: 'schema_changed' }
                  },
                  _meta: meta
                })
              )
              serverClosed = true
              break
            }
            try {
              const result = await pollSource(
                current,
                { ...prepared.request, cursor },
                { ...context, signal: abort.signal },
                options
              )
              if (result.terminated) {
                send(eventNotification('terminated', { error: result.terminated, _meta: meta }))
                serverClosed = true
                break
              }
              nextPollMs = result.nextPollMs ?? eventOptions(options).pollIntervalMs
              if (result.truncated) {
                cursor = result.cursor
                send(
                  eventNotification('active', {
                    cursor: encodedCursor(),
                    truncated: true,
                    _meta: meta
                  })
                )
              }
              for (const occurrence of result.events)
                sendOccurrence(occurrence, result.cursor !== null)
              if (result.events.length === 0) cursor = result.cursor
            } catch (_error) {
              if (abort.signal.aborted) break
              send(
                eventNotification('error', {
                  error: { code: -32603, message: 'UpstreamError' },
                  _meta: meta
                })
              )
            }
          }
          if (serverClosed && !abort.signal.aborted) {
            send({ jsonrpc: '2.0', id: parentId, result: { _meta: {} } })
            controller.close()
          }
        } catch {
          if (!abort.signal.aborted) controller.error(new Error('Event stream failed'))
        } finally {
          await cleanup?.()
        }
      })()
    },
    async cancel() {
      await cleanup?.()
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

export async function subscribeEventsWebhook(
  app: AnyElysiaApp,
  params: Record<string, unknown>,
  options: NormalizedMcpPluginOptions,
  context: McpInvocationContext
): Promise<Record<string, unknown>> {
  const config = eventOptions(options)
  const webhook = config.webhook
  if (!webhook) throw unsupported('deliveryMode', 'webhook')
  const principal = eventPrincipalKey(context.authorization)
  if (!principal) throw forbidden()
  const prepared = await prepareEventRequest(app, params, 'webhook', options, context)
  const delivery = params.delivery
  if (!delivery || typeof delivery !== 'object' || Array.isArray(delivery))
    throw invalidParams('Webhook delivery is required')
  const deliveryValue = delivery as Record<string, unknown>
  if (deliveryValue.mode !== 'webhook' || typeof deliveryValue.url !== 'string')
    throw invalidParams('Webhook delivery is invalid')
  try {
    parseWebhookUrl(deliveryValue.url)
  } catch {
    throw invalidParams('Webhook URL is invalid')
  }
  try {
    assertWebhookSecret(deliveryValue.secret)
  } catch (error) {
    throw invalidParams(error instanceof Error ? error.message : 'Webhook secret is invalid')
  }
  const deliveryUrl = deliveryValue.url
  const deliverySecret = deliveryValue.secret
  const identity = deriveWebhookSubscriptionIdentity(
    principal,
    deliveryUrl,
    prepared.request.name,
    prepared.request.arguments,
    config.cursor.signingKey,
    prepared.variant
  )
  return withWebhookLifecycleLock(app, options, identity.id, async () => {
    const existing = await webhook.provider.get(identity.key)
    if (
      existing &&
      (existing.key !== identity.key ||
        existing.id !== identity.id ||
        existing.principal !== principal ||
        existing.url !== deliveryUrl ||
        existing.name !== prepared.request.name ||
        canonicalJson(existing.arguments) !== canonicalJson(prepared.request.arguments) ||
        existing.variant !== prepared.variant)
    )
      throw internalError('Webhook provider returned an invalid subscription owner')
    const ttl = webhookGrant(params.ttlMs, webhook)
    const now = new Date()
    const refreshBefore = ttl === null ? null : new Date(now.getTime() + ttl).toISOString()
    const workers = webhookWorkers(app, options)
    const live = workers.get(identity.id)
    let cursor: string | null
    let truncated = false
    let record: McpWebhookSubscriptionRecord
    if (existing) {
      cursor = live?.cursor ?? decodePreparedCursor(prepared)
      truncated = !live && prepared.cursorExpired
      record = {
        ...existing,
        maxAgeMs: prepared.request.maxAgeMs,
        secret: deliverySecret,
        ...(existing.secret !== deliverySecret
          ? {
              previousSecret: existing.secret,
              previousSecretExpiresAt: Date.now() + webhook.secretRotationGraceMs
            }
          : {}),
        refreshBefore,
        active: true,
        updatedAt: now.toISOString(),
        deliveryStatus: existing.deliveryStatus
          ? { ...existing.deliveryStatus, active: true }
          : undefined
      }
    } else {
      cursor = decodePreparedCursor(prepared)
      truncated = prepared.cursorExpired
      record = {
        key: identity.key,
        id: identity.id,
        principal,
        name: prepared.request.name,
        arguments: structuredClone(prepared.request.arguments),
        maxAgeMs: prepared.request.maxAgeMs,
        url: deliveryUrl,
        secret: deliverySecret,
        refreshBefore,
        verified: false,
        active: true,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        variant: prepared.variant
      }
    }
    try {
      await verifyWebhookEndpoint(record, context, webhook, { app, options })
    } catch (error) {
      const reason =
        error instanceof McpWebhookVerificationError || error instanceof McpWebhookNetworkError
          ? error.reason
          : 'connection_refused'
      throw new McpEventProtocolError(-32015, 'CallbackEndpointError', { reason })
    }
    record.verified = true
    let responseCursor = cursor
    let responseTruncated = truncated
    let initialResult: McpEventPollResult | undefined
    let activePrimed = false
    let awaitInitialForSafeCursor = false
    const applyInitialResult = (
      result: McpEventPollResult,
      safeCursor: string | null,
      initial: boolean,
      cursorExpired: boolean
    ) => {
      if (result.terminated) throw eventError(result.terminated)
      responseTruncated = cursorExpired || (result.truncated ?? false)
      if (initial || result.events.length === 0) {
        responseCursor = result.cursor
        cursor = result.cursor
        initialResult = undefined
        return
      }
      responseCursor = safeCursor
      cursor = safeCursor
      awaitInitialForSafeCursor = (result.truncated ?? false) && result.events.length > 0
      result.truncated = false
      initialResult = result
    }
    if (live && !live.terminal) {
      const safeCursor = live.cursor
      const result = await pollSource(
        prepared.source,
        { ...prepared.request, cursor: safeCursor },
        context,
        options
      )
      applyInitialResult(result, safeCursor, false, false)
      activePrimed = true
    }
    let releaseRefresh: (() => void) | undefined
    if (live) {
      live.refreshGate = new Promise<void>((resolve) => {
        releaseRefresh = resolve
      })
      try {
        await live.persisting
      } catch (error) {
        live.refreshGate = undefined
        releaseRefresh?.()
        throw error
      }
    }
    let stored: Awaited<ReturnType<typeof webhook.provider.upsert>>
    try {
      stored = await webhook.provider.upsert(record, {
        maxSubscriptionsPerPrincipal: webhook.maxSubscriptionsPerPrincipal
      })
      if ('limitExceeded' in stored)
        throw new McpEventProtocolError(-32013, 'ResourceExhausted', {
          limit: 'subscriptions',
          max: webhook.maxSubscriptionsPerPrincipal
        })
      if (
        stored.record.key !== record.key ||
        stored.record.id !== record.id ||
        stored.record.principal !== record.principal ||
        stored.record.url !== record.url ||
        stored.record.name !== record.name ||
        stored.record.variant !== record.variant ||
        stored.record.maxAgeMs !== record.maxAgeMs ||
        canonicalJson(stored.record.arguments) !== canonicalJson(record.arguments)
      )
        throw internalError('Webhook provider changed subscription ownership')
      record = stored.record
    } catch (error) {
      if (live) live.refreshGate = undefined
      releaseRefresh?.()
      throw error
    }
    if (live) {
      live.abort.abort('Webhook subscription refreshed')
      releaseRefresh?.()
      await live.done
      if (!activePrimed) {
        cursor = live.cursor
        responseCursor = cursor
      }
      if (live.terminal && activePrimed) {
        activePrimed = false
        initialResult = undefined
        awaitInitialForSafeCursor = false
        cursor = decodePreparedCursor(prepared)
        responseCursor = cursor
        responseTruncated = prepared.cursorExpired
      }
    }
    if (!workers.has(record.id)) {
      const epoch = nextWebhookLifecycleEpoch(app, options, record.id)
      if (live?.terminal) {
        try {
          await live.definition.onUnsubscribe?.(record.arguments, record.id, live.context)
        } catch {
          // A completed terminal lifecycle does not prevent a new explicit subscription.
        }
      }
      let subscribed = false
      try {
        if (!live || live.terminal) {
          await prepared.source.definition.onSubscribe?.(record.arguments, record.id, context)
          subscribed = true
          const result = await pollSource(prepared.source, prepared.request, context, options)
          applyInitialResult(
            result,
            prepared.request.cursor,
            prepared.initial,
            prepared.cursorExpired
          )
        }
      } catch (error) {
        await webhook.provider.delete(record.key)
        if (subscribed)
          try {
            await prepared.source.definition.onUnsubscribe?.(record.arguments, record.id, context)
          } catch {
            // Failed setup remains failed after best-effort lifecycle cleanup.
          }
        retireWebhookLifecycleEpoch(app, options, record.id, epoch)
        if (error instanceof McpEventProtocolError) throw error
        throw internalError('Event subscription setup failed')
      }
      const worker = startWebhookWorker(
        app,
        record,
        cursor,
        context,
        prepared.source.definition,
        epoch,
        options,
        initialResult
      )
      if (awaitInitialForSafeCursor) {
        await worker.initialProcessed
        responseCursor = worker.cursor
      }
    }
    return {
      id: record.id,
      refreshBefore,
      cursor: encodeEventCursor(
        responseCursor,
        record.name,
        record.arguments,
        context.authorization,
        record.variant,
        config.cursor
      ),
      truncated: responseTruncated,
      ...(existing?.deliveryStatus ? { deliveryStatus: record.deliveryStatus } : {})
    }
  })
}

export async function unsubscribeEventsWebhook(
  app: AnyElysiaApp,
  params: Record<string, unknown>,
  options: NormalizedMcpPluginOptions,
  context: McpInvocationContext
): Promise<Record<string, never>> {
  const config = eventOptions(options)
  const webhook = config.webhook
  if (!webhook) throw unsupported('deliveryMode', 'webhook')
  const principal = eventPrincipalKey(context.authorization)
  if (!principal) throw forbidden()
  if (
    typeof params.name !== 'string' ||
    !params.arguments ||
    typeof params.arguments !== 'object' ||
    Array.isArray(params.arguments) ||
    !params.delivery ||
    typeof params.delivery !== 'object' ||
    Array.isArray(params.delivery) ||
    typeof (params.delivery as Record<string, unknown>).url !== 'string'
  )
    throw invalidParams('Webhook unsubscribe tuple is invalid')
  const url = (params.delivery as Record<string, unknown>).url as string
  try {
    parseWebhookUrl(url)
  } catch {
    throw invalidParams('Webhook URL is invalid')
  }
  const identity = deriveWebhookSubscriptionIdentity(
    principal,
    url,
    params.name,
    params.arguments as Record<string, unknown>,
    config.cursor.signingKey,
    eventVariantKey(context.meta)
  )
  return withWebhookLifecycleLock(app, options, identity.id, async () => {
    const record = await webhook.provider.get(identity.key)
    if (
      !record ||
      record.key !== identity.key ||
      record.id !== identity.id ||
      record.principal !== principal ||
      record.url !== url ||
      record.name !== params.name ||
      record.variant !== eventVariantKey(context.meta) ||
      canonicalJson(record.arguments) !== canonicalJson(params.arguments)
    )
      throw new McpEventProtocolError(-32011, 'NotFound', { kind: 'subscription' })
    const worker = webhookWorkers(app, options).get(record.id)
    const teardownDefinition = worker?.definition
    const teardownContext = worker?.context ?? context
    const retirementEpoch = nextWebhookLifecycleEpoch(app, options, record.id)
    try {
      worker?.abort.abort('Webhook subscription removed')
      await worker?.done
      webhookWorkers(app, options).delete(record.id)
      try {
        await webhook.provider.delete(record.key)
      } finally {
        try {
          const definition =
            teardownDefinition ??
            (await resolveEventSource(app, record.name, context, options)).definition
          await definition.onUnsubscribe?.(record.arguments, record.id, teardownContext)
        } catch {
          // Removal is complete even when the event type no longer exists.
        }
      }
    } finally {
      retireWebhookLifecycleEpoch(app, options, record.id, retirementEpoch)
    }
    return {}
  })
}

export function recoverWebhookSubscriptions(
  app: AnyElysiaApp,
  options: NormalizedMcpPluginOptions
): void {
  const config = options.extensions.events
  const webhook = config?.webhook
  if (!webhook) return
  queueMicrotask(() => {
    void (async () => {
      const records = await webhook.provider.list()
      if (!records) return
      for await (const record of records) {
        try {
          if (!record.verified || !record.active) continue
          if (
            record.maxAgeMs !== undefined &&
            (!Number.isSafeInteger(record.maxAgeMs) || record.maxAgeMs < 0)
          )
            continue
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
          if (identity.key !== record.key || identity.id !== record.id) continue
          await withWebhookLifecycleLock(app, options, record.id, async () => {
            const current = await webhook.provider.get(record.key)
            if (!current?.verified || !current.active) return
            if (
              current.key !== identity.key ||
              current.id !== identity.id ||
              current.principal !== record.principal ||
              current.variant !== record.variant
            )
              return
            if (webhookWorkers(app, options).has(current.id)) return
            const authorization = await webhook.provider.authorizeDelivery(current)
            if (!authorization || eventPrincipalKey(authorization) !== current.principal) return
            const context: McpInvocationContext = {
              request: new Request('https://localhost/mcp'),
              protocolVersion: LEGACY_PROTOCOL_VERSION,
              authorization,
              meta: current.variant
                ? { 'io.modelcontextprotocol/server-variant': current.variant }
                : undefined
            }
            const source = await resolveEventSource(app, current.name, context, options)
            await authorizeEvent(source.definition, current.arguments, context)
            await source.definition.onSubscribe?.(current.arguments, current.id, context)
            const epoch = nextWebhookLifecycleEpoch(app, options, current.id)
            startWebhookWorker(app, current, null, context, source.definition, epoch, options)
          })
        } catch {
          // One corrupt or unauthorized durable record must not block recovery of others.
        }
      }
    })().catch(() => {
      // Recovery failures remain isolated from plugin installation.
    })
  })
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
  let initialSettled = preparedInitialResult === undefined
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
  state.done = (async () => {
    let record = initialRecord
    let initializing = initialCursor === null && !preparedInitialResult
    let initialResult = preparedInitialResult
    let originalDescriptor: McpEventDescriptor | undefined
    let terminalCleanup = false
    try {
      while (!abort.signal.aborted) {
        if (record.refreshBefore !== null && Date.parse(record.refreshBefore) <= Date.now()) {
          terminalCleanup = true
          state.terminal = true
          break
        }
        const authorization = await webhook.provider.authorizeDelivery(record)
        if (!authorization || eventPrincipalKey(authorization) !== record.principal) {
          await terminateWebhook(record, forbiddenError(), webhook, abort.signal)
          terminalCleanup = true
          state.terminal = true
          break
        }
        const context: McpInvocationContext = {
          ...state.context,
          signal: abort.signal,
          authorization,
          meta: record.variant
            ? { ...state.context.meta, 'io.modelcontextprotocol/server-variant': record.variant }
            : state.context.meta
        }
        let source: EventSource
        try {
          source = await resolveEventSource(app, record.name, context, options)
          await authorizeEvent(source.definition, record.arguments, context)
        } catch (error) {
          await terminateWebhook(record, terminationForResolution(error), webhook, abort.signal)
          terminalCleanup = true
          state.terminal = true
          break
        }
        const currentDescriptor = eventDescriptor(source.definition)
        const schemaChange = originalDescriptor
          ? incompatibleEventSchema(originalDescriptor, currentDescriptor)
          : null
        if (
          originalDescriptor &&
          (originalDescriptor.delivery.some((mode) => !currentDescriptor.delivery.includes(mode)) ||
            schemaChange)
        ) {
          await terminateWebhook(
            record,
            {
              code: -32014,
              message: 'Unsupported',
              data: { feature: schemaChange ?? 'deliveryMode', reason: 'schema_changed' }
            },
            webhook,
            abort.signal
          )
          terminalCleanup = true
          state.terminal = true
          break
        }
        originalDescriptor ??= currentDescriptor
        state.definition = source.definition
        state.context = { ...context, signal: undefined }
        let processingPreparedResult = false
        try {
          processingPreparedResult = initialResult !== undefined
          const result =
            initialResult ??
            (await pollSource(
              source,
              {
                name: record.name,
                arguments: record.arguments,
                cursor: state.cursor,
                maxAgeMs: Math.min(record.maxAgeMs ?? config.maxAgeMs, config.maxAgeMs),
                maxEvents: config.maxEvents
              },
              context,
              options
            ))
          initialResult = undefined
          if (result.terminated) {
            if (processingPreparedResult && !initialSettled) {
              initialSettled = true
              rejectInitial(eventError(result.terminated))
            }
            await terminateWebhook(record, result.terminated, webhook, abort.signal)
            terminalCleanup = true
            state.terminal = true
            break
          }
          if (initializing) {
            result.events = []
            result.hasMore = false
            result.truncated = false
            initializing = false
          }
          const delayedGap = (result.truncated ?? false) && result.events.length > 0
          if (result.truncated && !delayedGap) {
            const fresh = encodeEventCursor(
              result.cursor,
              record.name,
              record.arguments,
              authorization,
              record.variant,
              config.cursor
            )
            await deliverWebhook(
              record,
              { type: 'gap', cursor: fresh },
              webhookControlMessageId('gap'),
              webhook,
              abort.signal
            )
            state.cursor = result.cursor
          }
          for (const occurrence of result.events) {
            if (result.cursor !== null && occurrence.cursor == null)
              throw internalError('Replayable webhook events require per-event cursors')
            const safeCursor = encodeEventCursor(
              state.cursor,
              record.name,
              record.arguments,
              authorization,
              record.variant,
              config.cursor
            )
            const delivery = await deliverWebhook(
              record,
              { ...occurrence, cursor: safeCursor },
              occurrence.eventId,
              webhook,
              abort.signal,
              async () => {
                const currentAuthorization = await webhook.provider.authorizeDelivery(record)
                if (
                  !currentAuthorization ||
                  eventPrincipalKey(currentAuthorization) !== record.principal
                )
                  return false
                return isEventAuthorizedForDelivery(source.definition, record.arguments, {
                  ...context,
                  authorization: currentAuthorization
                })
              }
            )
            state.cursor = occurrence.cursor ?? null
            record = updateDeliveryStatus(record, delivery.lastError)
          }
          state.cursor = result.cursor
          if (delayedGap) {
            const fresh = encodeEventCursor(
              state.cursor,
              record.name,
              record.arguments,
              authorization,
              record.variant,
              config.cursor
            )
            await deliverWebhook(
              record,
              { type: 'gap', cursor: fresh },
              webhookControlMessageId('gap'),
              webhook,
              abort.signal
            )
          }
          if (processingPreparedResult && !initialSettled) {
            initialSettled = true
            resolveInitial()
          }
          if (abort.signal.aborted) break
          await state.refreshGate
          if (abort.signal.aborted) break
          const persisting = persistWebhookRecord(record, webhook)
          state.persisting = persisting
          try {
            await persisting
          } finally {
            if (state.persisting === persisting) state.persisting = undefined
          }
        } catch (error) {
          if (processingPreparedResult && !initialSettled) {
            initialSettled = true
            rejectInitial(error)
          }
          if (abort.signal.aborted) break
          if (error instanceof McpWebhookDeliveryRevokedError) {
            await terminateWebhook(record, forbiddenError(), webhook, abort.signal)
            terminalCleanup = true
            state.terminal = true
            break
          }
          if (error instanceof McpEventProtocolError && error.code === -32603) {
            await terminateWebhook(
              record,
              { code: -32603, message: 'UpstreamError' },
              webhook,
              abort.signal
            )
            terminalCleanup = true
            state.terminal = true
            break
          }
        }
        await abortableDelay(config.pollIntervalMs, abort.signal)
      }
    } catch {
      if (!initialSettled) {
        initialSettled = true
        rejectInitial(internalError('UpstreamError'))
      }
      if (!abort.signal.aborted) {
        terminalCleanup = true
        state.terminal = true
      }
    } finally {
      if (!initialSettled) {
        initialSettled = true
        rejectInitial(internalError('UpstreamError'))
      }
      if (workers.get(record.id)?.abort === abort) workers.delete(record.id)
      if (terminalCleanup)
        scheduleWebhookTerminalCleanup(app, options, record, state, webhook).catch(() => {
          // Terminal cleanup failures remain isolated from request processing.
        })
    }
  })()
  return state
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
  if (typeof params.name !== 'string' || params.name.length === 0)
    throw invalidParams('Event name is required')
  const arguments_ = params.arguments ?? {}
  if (!arguments_ || typeof arguments_ !== 'object' || Array.isArray(arguments_))
    throw invalidParams('Event arguments must be an object')
  const maxEvents = params.maxEvents ?? config.maxEvents
  const maxAgeMs = params.maxAgeMs ?? config.maxAgeMs
  if (
    !Number.isSafeInteger(maxEvents) ||
    Number(maxEvents) <= 0 ||
    Number(maxEvents) > config.maxEvents
  )
    throw invalidParams('Event maxEvents is invalid')
  if (!Number.isSafeInteger(maxAgeMs) || Number(maxAgeMs) < 0 || Number(maxAgeMs) > config.maxAgeMs)
    throw invalidParams('Event maxAgeMs is invalid')
  const source = await resolveEventSource(app, params.name, context, options)
  if (!source.definition.delivery.includes(mode)) throw unsupported('deliveryMode', mode)
  try {
    assertEventArguments(source.definition, arguments_)
  } catch (error) {
    throw invalidParams(error instanceof Error ? error.message : 'Invalid event arguments')
  }
  await authorizeEvent(source.definition, arguments_, context)
  const variant = eventVariantKey(context.meta)
  let cursor: string | null
  let cursorExpired = false
  try {
    const decoded = decodeEventCursor(
      params.cursor,
      params.name,
      arguments_,
      context.authorization,
      variant,
      config.cursor
    )
    cursor = decoded.expired ? null : decoded.cursor
    cursorExpired = decoded.expired
  } catch {
    throw invalidParams('Invalid event cursor')
  }
  return {
    source,
    request: {
      name: params.name,
      arguments: structuredClone(arguments_),
      cursor,
      maxAgeMs: Number(maxAgeMs),
      maxEvents: Number(maxEvents)
    } as McpEventPollRequest,
    initial: params.cursor === undefined || params.cursor === null || cursorExpired,
    cursorExpired,
    variant
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

function eventRuntimeState(
  app: AnyElysiaApp,
  options: NormalizedMcpPluginOptions
): EventRuntimeState {
  let byOptions = EVENT_RUNTIME_STATES.get(app)
  if (!byOptions) {
    byOptions = new WeakMap()
    EVENT_RUNTIME_STATES.set(app, byOptions)
  }
  let state = byOptions.get(options)
  if (!state) {
    state = {
      workers: new Map(),
      lifecycleLocks: new Map(),
      lifecycleEpochs: new Map(),
      lifecycleCounter: 0n,
      pollLeases: new Map()
    }
    byOptions.set(options, state)
  }
  return state
}

function webhookWorkers(
  app: AnyElysiaApp,
  options: NormalizedMcpPluginOptions
): Map<string, WebhookWorkerState> {
  return eventRuntimeState(app, options).workers
}

async function withWebhookLifecycleLock<T>(
  app: AnyElysiaApp,
  options: NormalizedMcpPluginOptions,
  id: string,
  operation: () => Promise<T>
): Promise<T> {
  const locks = eventRuntimeState(app, options).lifecycleLocks
  const previous = locks.get(id) ?? Promise.resolve()
  let release = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const tail = previous.catch(() => {}).then(() => gate)
  locks.set(id, tail)
  await previous.catch(() => {})
  try {
    return await operation()
  } finally {
    release()
    if (locks.get(id) === tail) locks.delete(id)
  }
}

function nextWebhookLifecycleEpoch(
  app: AnyElysiaApp,
  options: NormalizedMcpPluginOptions,
  id: string
): bigint {
  const state = eventRuntimeState(app, options)
  const epoch = state.lifecycleCounter + 1n
  state.lifecycleCounter = epoch
  state.lifecycleEpochs.set(id, epoch)
  return epoch
}

function webhookLifecycleEpoch(
  app: AnyElysiaApp,
  options: NormalizedMcpPluginOptions,
  id: string
): bigint {
  return eventRuntimeState(app, options).lifecycleEpochs.get(id) ?? 0n
}

function retireWebhookLifecycleEpoch(
  app: AnyElysiaApp,
  options: NormalizedMcpPluginOptions,
  id: string,
  epoch: bigint
): void {
  const state = eventRuntimeState(app, options)
  if (state.lifecycleEpochs.get(id) !== epoch || state.workers.has(id)) return
  state.lifecycleEpochs.delete(id)
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

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason)
      return
    }
    let timer: ReturnType<typeof setTimeout>
    const finish = (callback: () => void) => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      callback()
    }
    const onAbort = () => finish(() => reject(signal.reason))
    timer = setTimeout(() => finish(resolve), ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}
