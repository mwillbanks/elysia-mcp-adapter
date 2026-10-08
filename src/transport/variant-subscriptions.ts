import { randomUUID } from 'node:crypto'
import type { McpAuthorizationContext } from '../extensions/auth/index.js'
import { MCP_SERVER_VARIANT_META_KEY, type McpServerVariant } from '../extensions/variants/index.js'
import { findResourceReader, getMcpRegistry } from '../registry.js'
import type {
  AnyElysiaApp,
  McpAuthorizationOptions,
  McpInvocationContext,
  McpServerNotification,
  NormalizedMcpPluginOptions
} from '../types.js'
import type { SkillDispatchContext } from './skill-requests.js'
import { linkAbortSignal, safelyReturnIterator } from './subscriptions.js'

const JSON_RPC_VERSION = '2.0' as const
const VARIANT_SESSIONS = new WeakMap<
  AnyElysiaApp,
  WeakMap<NormalizedMcpPluginOptions, Map<string, VariantSession>>
>()

export interface VariantSession {
  principal?: string
  variants: McpServerVariant[]
  streams: Map<ReadableStreamDefaultController<Uint8Array>, ReturnType<typeof setInterval>>
  subscriptions: Map<string, { uri: string; variantId: string; close?: () => Promise<void> }>
}

type VariantSubscriptionRegistration =
  VariantSession['subscriptions'] extends Map<string, infer Registration> ? Registration : never

export interface VariantSubscriptionRuntime {
  invocationContext: (
    request: Request,
    method: string,
    params: Record<string, unknown>,
    context: SkillDispatchContext,
    options: NormalizedMcpPluginOptions
  ) => Promise<McpInvocationContext>
  authorizeRequest: (
    request: Request,
    options: NormalizedMcpPluginOptions
  ) => Promise<McpAuthorizationContext | Response | undefined>
  enforceAuthorization: (
    requirement: McpAuthorizationOptions | undefined,
    authorization: McpAuthorizationContext | undefined,
    options: NormalizedMcpPluginOptions
  ) => void
  isAuthorized: (
    requirement: McpAuthorizationOptions | undefined,
    authorization: McpAuthorizationContext | undefined
  ) => boolean
  variantAllows: (variant: McpServerVariant, kind: 'resources', name: string) => boolean
  variantPrincipal: (authorization?: McpAuthorizationContext) => string | undefined
  error: (code: number, message: string, data?: unknown) => Error
}

export function variantSessions(
  app: AnyElysiaApp,
  options: NormalizedMcpPluginOptions
): Map<string, VariantSession> {
  let byOptions = VARIANT_SESSIONS.get(app)
  if (!byOptions) {
    byOptions = new WeakMap()
    VARIANT_SESSIONS.set(app, byOptions)
  }
  let sessions = byOptions.get(options)
  if (!sessions) {
    sessions = new Map()
    byOptions.set(options, sessions)
  }
  return sessions
}

function emitVariantNotification(session: VariantSession, notification: unknown): void {
  const chunk = new TextEncoder().encode(
    `event: message\ndata: ${JSON.stringify({ jsonrpc: JSON_RPC_VERSION, ...(notification as object) })}\n\n`
  )
  for (const stream of session.streams.keys()) stream.enqueue(chunk)
}

function unavailableVariantResource(
  context: SkillDispatchContext,
  runtime: VariantSubscriptionRuntime
): Error {
  return runtime.error(-32602, 'Resource is unavailable in the active variant', {
    activeVariant: context.activeVariant?.id
  })
}

class VariantResourceSubscription {
  readonly id = randomUUID()
  private readonly abort = new AbortController()
  private unlinkRequestAbort: () => void
  private iterator: AsyncIterator<McpServerNotification> | undefined
  private registration: VariantSubscriptionRegistration | undefined
  private closed = false

  constructor(
    private readonly app: AnyElysiaApp,
    private readonly request: Request,
    private readonly options: NormalizedMcpPluginOptions,
    private readonly context: SkillDispatchContext,
    private readonly session: VariantSession,
    private readonly uri: string,
    private readonly runtime: VariantSubscriptionRuntime
  ) {
    this.unlinkRequestAbort = linkAbortSignal(request.signal, this.abort)
  }

  async initialize(params: Record<string, unknown>): Promise<void> {
    const provider = this.options.core.subscriptions?.provider
    if (!provider) throw this.runtime.error(-32601, 'Resource subscriptions are not configured')
    try {
      const iterable = await provider.subscribe(
        { resourceSubscriptions: [this.uri] },
        await this.runtime.invocationContext(
          this.request,
          'resources/subscribe',
          params,
          { ...this.context, signal: this.abort.signal },
          this.options
        )
      )
      this.iterator = iterable[Symbol.asyncIterator]()
    } catch (error) {
      this.unlinkRequestAbort()
      this.abort.abort('Resource subscription setup failed')
      throw error
    }
    this.registration = {
      uri: this.uri,
      variantId: this.context.activeVariant?.id ?? '',
      close: () => this.close('Resource subscription closed')
    }
    this.session.subscriptions.set(this.id, this.registration)
    void this.consume()
  }

  private async consume(): Promise<void> {
    try {
      await this.consumeNotifications()
    } catch {
      this.emitListChanged()
    } finally {
      this.unregister()
      await this.close('Resource subscription ended')
    }
  }

  private unregister(): void {
    if (this.isCurrentRegistration()) this.session.subscriptions.delete(this.id)
  }

  private isCurrentRegistration(): boolean {
    return this.session.subscriptions.get(this.id) === this.registration
  }

  private async consumeNotifications(): Promise<void> {
    if (!this.iterator) return
    while (!this.closed) {
      const next = await this.iterator.next()
      if (next.done || !this.isCurrentRegistration()) return
      if (!this.matches(next.value)) continue
      if (!(await this.stillAuthorized())) {
        this.emitListChanged()
        return
      }
      emitVariantNotification(this.session, {
        ...next.value,
        params: {
          ...next.value.params,
          _meta: { [MCP_SERVER_VARIANT_META_KEY]: this.context.activeVariant?.id }
        }
      })
    }
  }

  private matches(notification: McpServerNotification): boolean {
    return (
      notification.method === 'notifications/resources/updated' &&
      notification.params.uri === this.uri
    )
  }

  private async stillAuthorized(): Promise<boolean> {
    const authorization = await this.runtime.authorizeRequest(this.request, this.options)
    if (authorization instanceof Response) return false
    if (this.runtime.variantPrincipal(authorization) !== this.session.principal) return false
    const variant = this.options.extensions.variants?.variants.find(
      ({ id }) => id === this.context.activeVariant?.id
    )
    if (!variant || !this.runtime.variantAllows(variant, 'resources', this.uri)) return false
    const reader = findResourceReader(getMcpRegistry(this.app, this.options), this.uri)
    return Boolean(
      reader && this.runtime.isAuthorized(reader.definition.authorization, authorization)
    )
  }

  private emitListChanged(): void {
    emitVariantNotification(this.session, {
      method: 'notifications/resources/list_changed',
      params: { _meta: { [MCP_SERVER_VARIANT_META_KEY]: this.context.activeVariant?.id } }
    })
  }

  async close(reason: string): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.abort.abort(reason)
    this.unlinkRequestAbort()
    await safelyReturnIterator(this.iterator)
  }
}

export async function subscribeVariantResource(
  app: AnyElysiaApp,
  params: Record<string, unknown>,
  request: Request,
  options: NormalizedMcpPluginOptions,
  context: SkillDispatchContext,
  runtime: VariantSubscriptionRuntime
): Promise<Record<string, unknown>> {
  if (!options.extensions.variants || !context.activeVariant || !context.sessionId) {
    throw runtime.error(-32601, 'Method not found: resources/subscribe')
  }
  if (!options.core.subscriptions?.resources) {
    throw runtime.error(-32601, 'Resource subscriptions are not configured')
  }
  const uri = params.uri
  if (typeof uri !== 'string' || !runtime.variantAllows(context.activeVariant, 'resources', uri)) {
    throw unavailableVariantResource(context, runtime)
  }
  const reader = findResourceReader(getMcpRegistry(app, options), uri)
  if (!reader) throw unavailableVariantResource(context, runtime)
  runtime.enforceAuthorization(reader.definition.authorization, context.authorization, options)
  const session = variantSessions(app, options).get(context.sessionId)
  if (!session) throw runtime.error(-32602, 'Unknown MCP session')
  const subscription = new VariantResourceSubscription(
    app,
    request,
    options,
    context,
    session,
    uri,
    runtime
  )
  await subscription.initialize(params)
  return { subscriptionId: subscription.id, activeVariant: context.activeVariant.id }
}

export async function unsubscribeVariantResource(
  app: AnyElysiaApp,
  params: Record<string, unknown>,
  options: NormalizedMcpPluginOptions,
  context: SkillDispatchContext,
  runtime: VariantSubscriptionRuntime
): Promise<Record<string, never>> {
  if (!options.extensions.variants || !context.sessionId) {
    throw runtime.error(-32601, 'Method not found: resources/unsubscribe')
  }
  if (typeof params.subscriptionId !== 'string') {
    throw runtime.error(-32602, 'resources/unsubscribe requires subscriptionId')
  }
  const session = variantSessions(app, options).get(context.sessionId)
  const subscription = session?.subscriptions.get(params.subscriptionId)
  if (!session || !subscription) throw runtime.error(-32602, 'Unknown resource subscription')
  session.subscriptions.delete(params.subscriptionId)
  await subscription.close?.()
  return {}
}
