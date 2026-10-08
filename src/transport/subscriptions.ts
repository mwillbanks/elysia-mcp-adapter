import type { McpAuthorizationContext } from '../extensions/auth/index.js'
import { missingRequiredScopes } from '../extensions/auth/index.js'
import {
  type DetailedTask,
  TaskController,
  TaskProtocolError,
  type TaskSubscription
} from '../extensions/tasks/index.js'
import { isRecord } from '../internal.js'
import { findResourceReader, getMcpRegistry } from '../registry.js'
import { type McpRegistryChangeKind, onRegistryChange } from '../state.js'
import type {
  AnyElysiaApp,
  JsonRpcRequest,
  JsonRpcResponse,
  McpServerNotification,
  NormalizedMcpPluginOptions
} from '../types.js'
import { modernResultMeta } from './core.js'
import { invocationContextBase } from './invocation-context.js'
import {
  McpProtocolError,
  type McpRequestProtocolContext,
  resolveRequestProtocol
} from './protocol.js'
import { isRequestId } from './request-id.js'

const JSON_RPC_VERSION = '2.0' as const
export async function handleSubscription(
  app: AnyElysiaApp,
  payload: JsonRpcRequest,
  request: Request,
  options: NormalizedMcpPluginOptions,
  authorization?: McpAuthorizationContext
): Promise<Response> {
  const params = isRecord(payload.params) ? payload.params : {}
  const notifications = isRecord(params.notifications) ? params.notifications : undefined
  const hasTaskFilter = Array.isArray(notifications?.taskIds)
  const hasCoreFilter = Boolean(
    notifications?.toolsListChanged ||
      notifications?.promptsListChanged ||
      notifications?.resourcesListChanged ||
      Array.isArray(notifications?.resourceSubscriptions)
  )
  if (hasTaskFilter && hasCoreFilter) {
    return handleMixedSubscription(app, payload, request, options, authorization)
  }
  if (hasTaskFilter) return handleTaskSubscription(app, payload, request, options, authorization)
  if (!isJsonRpcRequest(payload) || !isRequestId(payload.id)) {
    return jsonResponse(
      createErrorResponse(errorIdForRequest(request, options, payload), -32600, 'Invalid Request'),
      400
    )
  }
  try {
    const protocol = resolveRequestProtocol(request, payload, options)
    if (!protocol.modern)
      throw new SubscriptionError(
        -32601,
        'subscriptions/listen requires MCP 2026-07-28',
        undefined,
        404
      )
    if (!options.core.subscriptions || !notifications) {
      throw new SubscriptionError(-32601, 'Core subscriptions are not configured', undefined, 404)
    }
    const { accepted, abort, configured, iterator, unlinkIncomingAbort } =
      await openCoreSubscription(
        app,
        request,
        params,
        notifications,
        options,
        protocol,
        authorization
      )
    const subscriptionId = payload.id
    const encoder = new TextEncoder()
    let closed = false
    let heartbeat: ReturnType<typeof setInterval> | undefined
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const send = (message: unknown) => {
          if (!closed) controller.enqueue(encodeSseEvent(encoder, message))
        }
        send({
          jsonrpc: JSON_RPC_VERSION,
          method: 'notifications/subscriptions/acknowledged',
          params: {
            notifications: accepted,
            _meta: { 'io.modelcontextprotocol/subscriptionId': subscriptionId }
          }
        })
        heartbeat = setInterval(() => {
          if (!closed) controller.enqueue(encoder.encode(': heartbeat\n\n'))
        }, configured.heartbeatMs)
        void (async () => {
          for (;;) {
            const next = await iterator.next()
            if (next.done || closed) break
            if (!isAllowedNotification(next.value, accepted, app, options, authorization)) {
              throw new Error(
                `Subscription provider emitted unrequested notification: ${next.value.method}`
              )
            }
            send({
              jsonrpc: JSON_RPC_VERSION,
              method: next.value.method,
              params: {
                ...(next.value.params ?? {}),
                _meta: { 'io.modelcontextprotocol/subscriptionId': subscriptionId }
              }
            })
          }
          if (closed) return
          send(subscriptionCancelled(subscriptionId, 'Subscription ended by server'))
          send(subscriptionComplete(subscriptionId, options))
          closed = true
          unlinkIncomingAbort()
          if (heartbeat) clearInterval(heartbeat)
          controller.close()
        })().catch((error) => {
          if (closed) return
          send(subscriptionCancelled(subscriptionId, 'Subscription provider failed'))
          send(subscriptionComplete(subscriptionId, options))
          closed = true
          unlinkIncomingAbort()
          if (heartbeat) clearInterval(heartbeat)
          abort.abort('Subscription provider failed')
          void safelyReturnIterator(iterator)
          controller.close()
          void error
        })
      },
      cancel() {
        closed = true
        abort.abort('MCP subscription stream closed')
        unlinkIncomingAbort()
        if (heartbeat) clearInterval(heartbeat)
        void safelyReturnIterator(iterator)
      }
    })
    return sseResponse(body)
  } catch (error) {
    return jsonResponse(
      normalizeDispatchError(errorIdForRequest(request, options, payload), error),
      errorStatus(error)
    )
  }
}

function isAllowedNotification(
  notification: { method: string; params?: Record<string, unknown> },
  accepted: Record<string, unknown>,
  app: AnyElysiaApp,
  options: NormalizedMcpPluginOptions,
  authorization?: McpAuthorizationContext
): boolean {
  if (notification.method === 'notifications/tools/list_changed')
    return accepted.toolsListChanged === true
  if (notification.method === 'notifications/prompts/list_changed')
    return accepted.promptsListChanged === true
  if (notification.method === 'notifications/resources/list_changed')
    return accepted.resourcesListChanged === true
  if (notification.method === 'notifications/resources/updated') {
    return (
      typeof notification.params?.uri === 'string' &&
      Array.isArray(accepted.resourceSubscriptions) &&
      isAuthorizedSubscribedResourceUpdate(
        app,
        options,
        accepted.resourceSubscriptions,
        notification.params.uri,
        authorization
      )
    )
  }
  return false
}

function isAuthorizedSubscribedResourceUpdate(
  app: AnyElysiaApp,
  options: NormalizedMcpPluginOptions,
  subscribedUris: unknown[],
  updatedUri: string,
  authorization?: McpAuthorizationContext
): boolean {
  const registry = getMcpRegistry(app, options)
  const matchingSubscription = subscribedUris.find(
    (uri): uri is string => typeof uri === 'string' && isSameOrDescendantUri(uri, updatedUri)
  )
  if (!matchingSubscription) return false
  const subscribedReader = findResourceReader(registry, matchingSubscription)
  if (
    !subscribedReader ||
    !isAuthorized(subscribedReader.definition.authorization, authorization)
  ) {
    return false
  }
  const updatedReader = findResourceReader(registry, updatedUri)
  return !updatedReader || isAuthorized(updatedReader.definition.authorization, authorization)
}

function isSameOrDescendantUri(subscribedUri: string, updatedUri: string): boolean {
  if (subscribedUri === updatedUri) return true
  const subscribed = parseUrl(subscribedUri)
  const updated = parseUrl(updatedUri)
  if (!subscribed || !updated || urlAuthority(subscribed) !== urlAuthority(updated)) return false
  const basePath = subscribed.pathname.endsWith('/')
    ? subscribed.pathname
    : `${subscribed.pathname}/`
  return updated.pathname.startsWith(basePath)
}

function parseUrl(value: string): URL | undefined {
  try {
    return new URL(value)
  } catch {
    return undefined
  }
}

function urlAuthority(url: URL): string {
  return JSON.stringify([url.protocol, url.username, url.password, url.host, url.search, url.hash])
}

function acceptedCoreSubscriptionFilter(
  app: AnyElysiaApp,
  notifications: Record<string, unknown>,
  options: NormalizedMcpPluginOptions,
  authorization?: McpAuthorizationContext
): Record<string, unknown> {
  const configured = options.core.subscriptions
  if (!configured) {
    throw new SubscriptionError(-32601, 'Core subscriptions are not configured', undefined, 404)
  }
  validateCoreNotificationFilter(notifications)
  const acceptedResources = acceptedResourceSubscriptions(
    app,
    notifications.resourceSubscriptions,
    configured.resources,
    options,
    authorization
  )
  return pruneUndefined({
    toolsListChanged: acceptedChangeNotification(
      notifications.toolsListChanged,
      configured.toolsListChanged
    ),
    promptsListChanged: acceptedChangeNotification(
      notifications.promptsListChanged,
      configured.promptsListChanged
    ),
    resourcesListChanged: acceptedChangeNotification(
      notifications.resourcesListChanged,
      configured.resourcesListChanged
    ),
    resourceSubscriptions: acceptedResources
  })
}

function validateCoreNotificationFilter(notifications: Record<string, unknown>): void {
  for (const key of ['toolsListChanged', 'promptsListChanged', 'resourcesListChanged']) {
    const value = notifications[key]
    if (value !== undefined && typeof value !== 'boolean') {
      throw new SubscriptionError(-32602, `${key} must be boolean`)
    }
  }
  const requestedResources = notifications.resourceSubscriptions
  if (
    requestedResources !== undefined &&
    (!Array.isArray(requestedResources) ||
      !requestedResources.every((uri) => typeof uri === 'string'))
  ) {
    throw new SubscriptionError(-32602, 'resourceSubscriptions must contain only strings')
  }
}

function acceptedResourceSubscriptions(
  app: AnyElysiaApp,
  requested: unknown,
  enabled: boolean | undefined,
  options: NormalizedMcpPluginOptions,
  authorization?: McpAuthorizationContext
): string[] | undefined {
  if (!Array.isArray(requested)) return undefined
  const accepted = requested.filter((uri): uri is string => {
    if (typeof uri !== 'string') return false
    const reader = findResourceReader(getMcpRegistry(app, options), uri)
    return Boolean(
      enabled && reader && isAuthorized(reader.definition.authorization, authorization)
    )
  })
  return [...new Set(accepted)]
}

function acceptedChangeNotification(
  requested: unknown,
  enabled: boolean | undefined
): true | undefined {
  return requested === true && enabled ? true : undefined
}

async function openCoreSubscription(
  app: AnyElysiaApp,
  request: Request,
  params: Record<string, unknown>,
  notifications: Record<string, unknown>,
  options: NormalizedMcpPluginOptions,
  protocol: McpRequestProtocolContext,
  authorization?: McpAuthorizationContext
) {
  const configured = options.core.subscriptions
  if (!configured) {
    throw new SubscriptionError(-32601, 'Core subscriptions are not configured', undefined, 404)
  }
  const accepted = acceptedCoreSubscriptionFilter(app, notifications, options, authorization)
  const abort = new AbortController()
  const unlinkIncomingAbort = linkAbortSignal(request.signal, abort)
  const invocation = invocationContextBase(request, params, {
    protocol,
    authorization,
    signal: abort.signal
  })
  try {
    const iterable = await configured.provider.subscribe(accepted, invocation)
    return {
      accepted,
      abort,
      configured,
      iterator: mergeRegistryNotifications(
        app,
        iterable[Symbol.asyncIterator](),
        accepted,
        abort.signal
      ),
      unlinkIncomingAbort
    }
  } catch (error) {
    unlinkIncomingAbort()
    throw error
  }
}

function mergeRegistryNotifications(
  app: AnyElysiaApp,
  provider: AsyncIterator<McpServerNotification>,
  accepted: Record<string, unknown>,
  signal: AbortSignal
): AsyncIterableIterator<McpServerNotification> {
  const queued: McpServerNotification[] = []
  let wake: (() => void) | undefined
  let providerNext: Promise<IteratorResult<McpServerNotification>> | undefined
  let closed = false
  const enabled = (kind: McpRegistryChangeKind): boolean => accepted[`${kind}ListChanged`] === true
  const removeListener = onRegistryChange(app, (kind) => {
    if (!closed && enabled(kind)) {
      queued.push({ method: `notifications/${kind}/list_changed` } as McpServerNotification)
      wake?.()
    }
  })
  const close = () => {
    if (closed) return
    closed = true
    removeListener()
    wake?.()
  }
  signal.addEventListener('abort', close, { once: true })
  return {
    [Symbol.asyncIterator]() {
      return this
    },
    async next() {
      for (;;) {
        const local = queued.shift()
        if (local) return { done: false, value: local }
        if (closed) return { done: true, value: undefined }
        providerNext ??= provider.next()
        let localWake: (() => void) | undefined
        const localReady = new Promise<'local'>((resolve) => {
          localWake = () => resolve('local')
          wake = localWake
        })
        const result = await Promise.race([
          providerNext.then((value) => ({ source: 'provider' as const, value })),
          localReady.then(() => ({ source: 'local' as const }))
        ])
        if (wake === localWake) wake = undefined
        if (result.source === 'local') continue
        providerNext = undefined
        if (result.value.done) close()
        return result.value
      }
    },
    async return(value?: unknown) {
      close()
      const result = await provider.return?.(value)
      return result ?? { done: true, value: undefined }
    },
    async throw(error?: unknown) {
      close()
      if (provider.throw) return provider.throw(error)
      throw error
    }
  }
}

function prepareTaskSubscriptionRequest(
  request: Request,
  payload: JsonRpcRequest,
  options: NormalizedMcpPluginOptions,
  authorization?: McpAuthorizationContext
) {
  const protocol = resolveRequestProtocol(request, payload, options)
  const context = { protocol, authorization }
  assertModernTasks(context, options)
  const params = isRecord(payload.params) ? payload.params : {}
  return {
    context,
    meta: isRecord(params._meta) ? params._meta : undefined,
    params,
    protocol
  }
}

interface MixedRequest {
  context: ReturnType<typeof prepareTaskSubscriptionRequest>['context']
  params: Record<string, unknown>
  protocol: McpRequestProtocolContext
  taskIds: string[]
}

function mixedRequest(
  request: Request,
  payload: JsonRpcRequest,
  options: NormalizedMcpPluginOptions,
  authorization?: McpAuthorizationContext
): MixedRequest {
  if (!isRequestId(payload.id)) {
    throw new SubscriptionError(-32600, 'Invalid Request', undefined, 400)
  }
  const prepared = prepareTaskSubscriptionRequest(request, payload, options, authorization)
  taskController(options).assertClientCapability(prepared.meta)
  const notifications = isRecord(prepared.params.notifications) ? prepared.params.notifications : {}
  const taskIds = notifications.taskIds
  if (!Array.isArray(taskIds) || !taskIds.every((value) => typeof value === 'string')) {
    throw new SubscriptionError(-32602, 'notifications.taskIds must contain only strings')
  }
  return { ...prepared, taskIds }
}

class MixedSubscriptionSession {
  readonly abort: AbortController
  readonly acceptedCore: Record<string, unknown>
  readonly configured: NonNullable<NormalizedMcpPluginOptions['core']['subscriptions']>
  readonly iterator: AsyncIterator<McpServerNotification>
  readonly unlinkIncomingAbort: () => void
  private readonly encoder = new TextEncoder()
  private readonly queuedTasks: DetailedTask[] = []
  private acceptedTasks: Set<string> | undefined
  private controller: ReadableStreamDefaultController<Uint8Array> | undefined
  private tasks: TaskSubscription | undefined
  private closeTasksPromise: Promise<void> | undefined
  private heartbeat: ReturnType<typeof setInterval> | undefined
  private closeTasksOnAbort: (() => void) | undefined
  private closed = false

  constructor(
    core: Awaited<ReturnType<typeof openCoreSubscription>>,
    private readonly app: AnyElysiaApp,
    private readonly request: Request,
    private readonly params: Record<string, unknown>,
    private readonly context: MixedRequest['context'],
    private readonly taskIds: string[],
    private readonly subscriptionId: string | number,
    private readonly options: NormalizedMcpPluginOptions,
    private readonly authorization?: McpAuthorizationContext
  ) {
    this.abort = core.abort
    this.acceptedCore = core.accepted
    this.configured = core.configured
    this.iterator = core.iterator
    this.unlinkIncomingAbort = core.unlinkIncomingAbort
  }

  async initialize(): Promise<void> {
    this.tasks = await taskController(this.options).listen(
      this.taskIds,
      (task) => this.emitTask(task),
      taskRequestContext(this.request, this.params, {
        ...this.context,
        signal: this.abort.signal
      })
    )
    this.closeTasksOnAbort = () => void this.closeTasks()
    this.abort.signal.addEventListener('abort', this.closeTasksOnAbort, { once: true })
    this.acceptedTasks = new Set(acceptedSubscriptionTaskIds(this.tasks, this.taskIds))
  }

  stream(): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
      start: (controller) => this.start(controller),
      cancel: () => this.cancel()
    })
  }

  async cleanupSetup(): Promise<void> {
    this.abort.abort('Mixed subscription setup failed')
    this.unlinkIncomingAbort()
    await Promise.all([safelyReturnIterator(this.iterator), this.closeTasks()])
  }

  private event(message: unknown): Uint8Array {
    return encodeSseEvent(this.encoder, message)
  }

  private emitTask(task: DetailedTask): void {
    if (this.closed) return
    if (
      rejectUnacceptedTask(
        task.taskId,
        this.acceptedTasks,
        this.controller,
        (message) => this.event(message),
        this.subscriptionId,
        this.options
      )
    ) {
      this.fail('Task subscription provider failed')
      return
    }
    deliverTask(
      task,
      this.controller,
      this.queuedTasks,
      (message) => this.event(message),
      this.subscriptionId
    )
  }

  private start(controller: ReadableStreamDefaultController<Uint8Array>): void {
    this.controller = controller
    const acceptedTaskIds = [...(this.acceptedTasks ?? [])]
    controller.enqueue(
      this.event(
        subscriptionAcknowledged(this.subscriptionId, {
          ...this.acceptedCore,
          taskIds: acceptedTaskIds
        })
      )
    )
    for (const task of this.queuedTasks) this.emitTask(task)
    this.queuedTasks.length = 0
    this.heartbeat = setInterval(() => this.sendHeartbeat(), this.configured.heartbeatMs)
    const coreDone = this.consumeCore()
    this.observeCompletion(coreDone)
  }

  private async consumeCore(): Promise<void> {
    for (;;) {
      const next = await this.iterator.next()
      if (next.done || this.closed) return
      if (
        !isAllowedNotification(
          next.value,
          this.acceptedCore,
          this.app,
          this.options,
          this.authorization
        )
      ) {
        throw new Error(
          `Subscription provider emitted unrequested notification: ${next.value.method}`
        )
      }
      this.controller?.enqueue(this.event(coreNotification(next.value, this.subscriptionId)))
    }
  }

  private observeCompletion(coreDone: Promise<void>): void {
    const completion = this.tasks?.done ? Promise.all([coreDone, this.tasks.done]) : coreDone
    void completion.then(() => this.finish()).catch(() => this.fail('Subscription provider failed'))
  }

  private finish(): void {
    if (this.closed) return
    this.sendTerminal('Subscription ended by server')
    this.closeStream()
  }

  private fail(reason: string): void {
    if (this.closed) return
    this.sendTerminal(reason)
    this.abort.abort(reason)
    void safelyReturnIterator(this.iterator)
    this.closeStream()
  }

  private sendTerminal(reason: string): void {
    this.controller?.enqueue(this.event(subscriptionCancelled(this.subscriptionId, reason)))
    this.controller?.enqueue(this.event(subscriptionComplete(this.subscriptionId, this.options)))
  }

  private closeStream(): void {
    this.closed = true
    this.unlinkIncomingAbort()
    if (this.heartbeat) clearInterval(this.heartbeat)
    void this.closeTasks()
    this.controller?.close()
  }

  private sendHeartbeat(): void {
    if (!this.closed) this.controller?.enqueue(this.encoder.encode(': heartbeat\n\n'))
  }

  private cancel(): void {
    if (this.closed) return
    this.closed = true
    this.abort.abort('MCP subscription stream closed')
    this.unlinkIncomingAbort()
    if (this.heartbeat) clearInterval(this.heartbeat)
    void safelyReturnIterator(this.iterator)
    void this.closeTasks()
  }

  private closeTasks(): Promise<void> {
    if (this.closeTasksOnAbort) {
      this.abort.signal.removeEventListener('abort', this.closeTasksOnAbort)
      this.closeTasksOnAbort = undefined
    }
    this.closeTasksPromise ??= safelyCloseTaskSubscription(this.tasks)
    return this.closeTasksPromise
  }
}

function taskNotification(
  task: DetailedTask,
  subscriptionId: string | number
): Record<string, unknown> {
  return {
    jsonrpc: JSON_RPC_VERSION,
    method: 'notifications/tasks',
    params: { ...task, _meta: { 'io.modelcontextprotocol/subscriptionId': subscriptionId } }
  }
}

function coreNotification(
  notification: McpServerNotification,
  subscriptionId: string | number
): Record<string, unknown> {
  return {
    jsonrpc: JSON_RPC_VERSION,
    method: notification.method,
    params: {
      ...(notification.params ?? {}),
      _meta: { 'io.modelcontextprotocol/subscriptionId': subscriptionId }
    }
  }
}

function subscriptionAcknowledged(
  subscriptionId: string | number,
  notifications: Record<string, unknown>
): Record<string, unknown> {
  return {
    jsonrpc: JSON_RPC_VERSION,
    method: 'notifications/subscriptions/acknowledged',
    params: {
      notifications,
      _meta: { 'io.modelcontextprotocol/subscriptionId': subscriptionId }
    }
  }
}

async function createMixedSubscription(
  app: AnyElysiaApp,
  payload: JsonRpcRequest,
  request: Request,
  options: NormalizedMcpPluginOptions,
  authorization?: McpAuthorizationContext
): Promise<MixedSubscriptionSession> {
  const prepared = mixedRequest(request, payload, options, authorization)
  const notifications = isRecord(prepared.params.notifications) ? prepared.params.notifications : {}
  const core = await openCoreSubscription(
    app,
    request,
    prepared.params,
    notifications,
    options,
    prepared.protocol,
    authorization
  )
  const session = new MixedSubscriptionSession(
    core,
    app,
    request,
    prepared.params,
    prepared.context,
    prepared.taskIds,
    payload.id as string | number,
    options,
    authorization
  )
  try {
    await session.initialize()
    return session
  } catch (error) {
    await session.cleanupSetup()
    throw error
  }
}

async function handleMixedSubscription(
  app: AnyElysiaApp,
  payload: JsonRpcRequest,
  request: Request,
  options: NormalizedMcpPluginOptions,
  authorization?: McpAuthorizationContext
): Promise<Response> {
  return subscriptionResponse(request, payload, options, () =>
    createMixedSubscription(app, payload, request, options, authorization)
  )
}

export function sseResponse(body: ReadableStream<Uint8Array>): Response {
  return new Response(body, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no',
      connection: 'keep-alive'
    }
  })
}

export function linkAbortSignal(source: AbortSignal, target: AbortController): () => void {
  if (source.aborted) {
    target.abort(source.reason)
    return () => undefined
  }
  const abort = () => target.abort(source.reason)
  source.addEventListener('abort', abort, { once: true })
  return () => source.removeEventListener('abort', abort)
}

function encodeSseEvent(encoder: TextEncoder, message: unknown): Uint8Array {
  return encoder.encode(`event: message\ndata: ${JSON.stringify(message)}\n\n`)
}

function subscriptionCancelled(
  subscriptionId: string | number,
  reason: string
): Record<string, unknown> {
  return {
    jsonrpc: JSON_RPC_VERSION,
    method: 'notifications/cancelled',
    params: {
      requestId: subscriptionId,
      reason,
      _meta: { 'io.modelcontextprotocol/subscriptionId': subscriptionId }
    }
  }
}

function subscriptionComplete(
  subscriptionId: string | number,
  options: NormalizedMcpPluginOptions
): Record<string, unknown> {
  return {
    jsonrpc: JSON_RPC_VERSION,
    id: subscriptionId,
    result: {
      resultType: 'complete',
      _meta: {
        ...modernResultMeta(options),
        'io.modelcontextprotocol/subscriptionId': subscriptionId
      }
    }
  }
}

interface TaskSubscriptionRequest {
  context: ReturnType<typeof prepareTaskSubscriptionRequest>['context']
  params: Record<string, unknown>
  taskIds: string[]
}

function taskSubscriptionRequest(
  request: Request,
  payload: JsonRpcRequest,
  options: NormalizedMcpPluginOptions,
  authorization?: McpAuthorizationContext
): TaskSubscriptionRequest {
  const prepared = prepareTaskSubscriptionRequest(request, payload, options, authorization)
  taskController(options).assertClientCapability(prepared.meta)
  const notifications = prepared.params.notifications
  if (!isRecord(notifications) || !Array.isArray(notifications.taskIds)) {
    throw new SubscriptionError(-32602, 'subscriptions/listen requires notifications.taskIds')
  }
  if (!notifications.taskIds.every((value) => typeof value === 'string')) {
    throw new SubscriptionError(-32602, 'notifications.taskIds must contain only strings')
  }
  return { context: prepared.context, params: prepared.params, taskIds: notifications.taskIds }
}

class TaskSubscriptionSession {
  private readonly abort = new AbortController()
  private readonly encoder = new TextEncoder()
  private readonly queued: DetailedTask[] = []
  private readonly unlinkIncomingAbort: () => void
  private accepted: Set<string> | undefined
  private subscription: TaskSubscription | undefined
  private cleanupPromise: Promise<void> | undefined
  private controller: ReadableStreamDefaultController<Uint8Array> | undefined
  private closed = false

  constructor(
    private readonly request: Request,
    private readonly prepared: TaskSubscriptionRequest,
    private readonly subscriptionId: string | number,
    private readonly options: NormalizedMcpPluginOptions
  ) {
    this.unlinkIncomingAbort = linkAbortSignal(request.signal, this.abort)
    this.abort.signal.addEventListener('abort', () => this.handleAbort(), { once: true })
  }

  async initialize(): Promise<void> {
    try {
      this.subscription = await taskController(this.options).listen(
        this.prepared.taskIds,
        (task) => this.enqueueTask(task),
        taskRequestContext(this.request, this.prepared.params, {
          ...this.prepared.context,
          signal: this.abort.signal
        })
      )
    } catch (error) {
      this.abort.abort('Task subscription setup failed')
      this.unlinkIncomingAbort()
      throw error
    }
    if (this.abort.signal.aborted) {
      this.closed = true
      await this.close()
    }
    const acceptedIds = acceptedSubscriptionTaskIds(this.subscription, this.prepared.taskIds)
    this.accepted = new Set(acceptedIds)
    if (this.queued.some((task) => !this.accepted?.has(task.taskId))) {
      await this.close()
      throw new Error('Task provider emitted a notification for an unaccepted task')
    }
  }

  stream(): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
      start: (controller) => this.start(controller),
      cancel: async () => {
        this.closed = true
        this.abort.abort('MCP subscription stream closed')
        await this.close()
      }
    })
  }

  async close(): Promise<void> {
    this.unlinkIncomingAbort()
    this.cleanupPromise ??= safelyCloseTaskSubscription(this.subscription)
    return this.cleanupPromise
  }

  private event(message: unknown): Uint8Array {
    return encodeSseEvent(this.encoder, message)
  }

  private enqueueTask(task: DetailedTask): void {
    if (this.closed) return
    if (
      rejectUnacceptedTask(
        task.taskId,
        this.accepted,
        this.controller,
        (message) => this.event(message),
        this.subscriptionId,
        this.options
      )
    ) {
      this.closed = true
      void this.close()
      return
    }
    deliverTask(
      task,
      this.controller,
      this.queued,
      (message) => this.event(message),
      this.subscriptionId
    )
  }

  private start(controller: ReadableStreamDefaultController<Uint8Array>): void {
    this.controller = controller
    if (this.closed) {
      controller.close()
      return
    }
    controller.enqueue(
      this.event(
        subscriptionAcknowledged(this.subscriptionId, {
          taskIds: [...(this.accepted ?? [])]
        })
      )
    )
    for (const task of this.queued) this.enqueueTask(task)
    this.queued.length = 0
    if (!this.subscription) void this.terminate('Subscription ended by server')
    else if (this.subscription.done) void this.observeDone()
  }

  private async observeDone(): Promise<void> {
    try {
      await this.subscription?.done
    } catch {
      if (!this.closed) await this.terminate('Task subscription provider failed')
      return
    }
    if (!this.closed) await this.terminate('Subscription ended by server')
  }

  private async terminate(reason: string): Promise<void> {
    this.controller?.enqueue(this.event(subscriptionCancelled(this.subscriptionId, reason)))
    this.controller?.enqueue(this.event(subscriptionComplete(this.subscriptionId, this.options)))
    this.closed = true
    await this.close()
    this.controller?.close()
  }

  private handleAbort(): void {
    this.closed = true
    void this.close()
    try {
      this.controller?.close()
    } catch {
      // Another terminal path can close the response stream first.
    }
  }
}

async function createTaskSubscription(
  payload: JsonRpcRequest,
  request: Request,
  options: NormalizedMcpPluginOptions,
  authorization?: McpAuthorizationContext
): Promise<TaskSubscriptionSession> {
  const prepared = taskSubscriptionRequest(request, payload, options, authorization)
  const session = new TaskSubscriptionSession(
    request,
    prepared,
    payload.id as string | number,
    options
  )
  try {
    await session.initialize()
    return session
  } catch (error) {
    await session.close()
    throw error
  }
}

async function handleTaskSubscription(
  _app: AnyElysiaApp,
  payload: JsonRpcRequest,
  request: Request,
  options: NormalizedMcpPluginOptions,
  authorization?: McpAuthorizationContext
): Promise<Response> {
  if (!isJsonRpcRequest(payload) || !isRequestId(payload.id)) {
    return jsonResponse(
      createErrorResponse(errorIdForRequest(request, options, payload), -32600, 'Invalid Request'),
      400
    )
  }
  return subscriptionResponse(request, payload, options, () =>
    createTaskSubscription(payload, request, options, authorization)
  )
}

interface StreamSession {
  stream(): ReadableStream<Uint8Array>
}

async function subscriptionResponse(
  request: Request,
  payload: JsonRpcRequest,
  options: NormalizedMcpPluginOptions,
  create: () => Promise<StreamSession>
): Promise<Response> {
  try {
    return sseResponse((await create()).stream())
  } catch (error) {
    return jsonResponse(
      normalizeDispatchError(errorIdForRequest(request, options, payload), error),
      errorStatus(error)
    )
  }
}

function deliverTask(
  task: DetailedTask,
  controller: ReadableStreamDefaultController<Uint8Array> | undefined,
  queue: DetailedTask[],
  event: (message: unknown) => Uint8Array,
  subscriptionId: string | number
): void {
  if (!controller) {
    queue.push(task)
    return
  }
  controller.enqueue(event(taskNotification(task, subscriptionId)))
}

function rejectUnacceptedTask(
  taskId: string,
  accepted: Set<string> | undefined,
  controller: ReadableStreamDefaultController<Uint8Array> | undefined,
  event: (message: unknown) => Uint8Array,
  subscriptionId: string | number,
  options: NormalizedMcpPluginOptions
): boolean {
  if (!accepted || accepted.has(taskId)) return false
  if (controller) {
    controller.enqueue(
      event(subscriptionCancelled(subscriptionId, 'Task subscription provider failed'))
    )
    controller.enqueue(event(subscriptionComplete(subscriptionId, options)))
    controller.close()
  }
  return true
}

async function safelyCloseTaskSubscription(
  subscription: TaskSubscription | undefined
): Promise<void> {
  try {
    await subscription?.close()
  } catch {
    // Cleanup failures cannot change an established protocol response or stream error.
  }
}

export async function safelyReturnIterator(
  iterator: AsyncIterator<McpServerNotification> | undefined
): Promise<void> {
  try {
    await iterator?.return?.()
  } catch {
    // Cleanup failures cannot hide the original subscription setup failure.
  }
}

function acceptedSubscriptionTaskIds(
  subscription: TaskSubscription | undefined,
  requestedTaskIds: readonly string[]
): string[] {
  if (!subscription) return []
  const accepted = subscription.acceptedTaskIds ?? requestedTaskIds
  const requested = new Set(requestedTaskIds)
  if (!accepted.every((taskId) => typeof taskId === 'string' && requested.has(taskId))) {
    throw new Error('Task provider accepted an unrequested subscription task')
  }
  return [...new Set(accepted)]
}

function taskController(options: NormalizedMcpPluginOptions): TaskController {
  const tasks = options.extensions.tasks
  if (!tasks) throw new SubscriptionError(-32601, 'Tasks extension is not enabled', undefined, 404)
  return new TaskController({ provider: tasks.provider, version: tasks.version })
}

function assertModernTasks(
  context: { protocol: McpRequestProtocolContext },
  options: NormalizedMcpPluginOptions
): void {
  if (!context.protocol.modern || !options.extensions.tasks) {
    throw new SubscriptionError(-32601, 'Tasks extension is not enabled', undefined, 404)
  }
}

function taskRequestContext(
  request: Request,
  params: Record<string, unknown>,
  context: {
    protocol: McpRequestProtocolContext
    authorization?: McpAuthorizationContext
    signal?: AbortSignal
  }
) {
  return {
    request,
    signal: context.signal ?? request.signal,
    meta: isRecord(params._meta) ? params._meta : undefined,
    authorization: context.authorization,
    protocolVersion: context.protocol.version,
    clientCapabilities: context.protocol.clientCapabilities,
    clientInfo: context.protocol.clientInfo
  }
}

function isAuthorized(
  requirement: { requiredScopes?: readonly string[] } | undefined,
  authorization: McpAuthorizationContext | undefined
): boolean {
  const required = requirement?.requiredScopes ?? []
  return (
    required.length === 0 ||
    Boolean(authorization && missingRequiredScopes(required, authorization.scopes).length === 0)
  )
}

function isJsonRpcRequest(value: unknown): value is JsonRpcRequest {
  return (
    isRecord(value) &&
    value.jsonrpc === JSON_RPC_VERSION &&
    typeof value.method === 'string' &&
    (value.params === undefined || isRecord(value.params)) &&
    (value.id === undefined || value.id === null || isRequestId(value.id))
  )
}

function pruneUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T
}

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status })
}

function createErrorResponse(
  id: string | number | null | undefined,
  code: number,
  message: string,
  data?: unknown
): JsonRpcResponse {
  return { jsonrpc: JSON_RPC_VERSION, id: id ?? null, error: { code, message, data } }
}

function errorIdForRequest(
  _request: Request,
  _options: NormalizedMcpPluginOptions,
  payload?: unknown
): string | number | null {
  if (isRecord(payload) && isRequestId(payload.id)) return payload.id
  return null
}

function normalizeDispatchError(id: string | number | null, error: unknown): JsonRpcResponse {
  if (
    error instanceof SubscriptionError ||
    error instanceof McpProtocolError ||
    error instanceof TaskProtocolError
  ) {
    return createErrorResponse(
      id,
      error.code,
      error.message,
      'data' in error ? error.data : undefined
    )
  }
  return createErrorResponse(id, -32603, error instanceof Error ? error.message : 'Internal error')
}

function errorStatus(error: unknown): number {
  if (error instanceof SubscriptionError || error instanceof McpProtocolError) return error.status
  if (error instanceof TaskProtocolError && (error.code === -32021 || error.code === -32003))
    return 400
  return 200
}

class SubscriptionError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
    readonly status = 200
  ) {
    super(message)
  }
}
