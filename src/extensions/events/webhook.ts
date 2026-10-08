import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { AnyElysiaApp, McpInvocationContext, NormalizedMcpPluginOptions } from '../../types.js'
import { canonicalJson } from './cursor.js'
import { abortableDelay } from './delay.js'
import {
  McpWebhookNetworkError,
  parseWebhookUrl,
  postWebhook,
  resolveWebhookEndpoint
} from './network.js'
import type {
  McpEventWebhookOptions,
  McpWebhookLastError,
  McpWebhookSubscriptionRecord,
  NormalizedMcpEventsOptions
} from './types.js'

const MAX_VERIFICATION_CACHE_ENTRIES = 1_024
const MAX_TIMER_DELAY_MS = 2_147_483_647
const APP_VERIFICATION_STATES = new WeakMap<
  AnyElysiaApp,
  WeakMap<NormalizedMcpPluginOptions, WebhookVerificationState>
>()
const STANDALONE_VERIFICATION_STATES = new WeakMap<
  NonNullable<NormalizedMcpEventsOptions['webhook']>,
  WebhookVerificationState
>()

interface WebhookVerificationState {
  verifiedEndpoints: Map<string, number>
  lastChallenge: Map<string, number>
  cleanupTimer?: ReturnType<typeof setTimeout>
}

export interface McpWebhookVerificationScope {
  app: AnyElysiaApp
  options: NormalizedMcpPluginOptions
}

export interface McpWebhookDeliveryResult {
  acknowledged: boolean
  abandoned: boolean
  lastError: McpWebhookLastError | null
  attempts: number
}

export function assertWebhookSecret(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.startsWith('whsec_'))
    throw new TypeError('Webhook secret must use the whsec_ format')
  let bytes: Uint8Array
  try {
    const encoded = value.slice(6)
    bytes = Buffer.from(encoded, 'base64')
    if (Buffer.from(bytes).toString('base64') !== encoded) throw new Error('non-canonical base64')
  } catch {
    throw new TypeError('Webhook secret must contain canonical base64')
  }
  if (bytes.byteLength < 24 || bytes.byteLength > 64)
    throw new TypeError('Webhook secret must decode to 24 through 64 bytes')
}

export function deriveWebhookSubscriptionIdentity(
  principal: string,
  url: string,
  name: string,
  arguments_: Record<string, unknown>,
  signingKey: string | Uint8Array,
  variant?: string
): { key: string; id: string } {
  const tuple = canonicalJson(
    variant === undefined
      ? [principal, url, name, arguments_]
      : [principal, variant, url, name, arguments_]
  )
  const digest = createHmac('sha256', signingKey).update(tuple).digest('base64url')
  return { key: digest, id: `sub_${digest.slice(0, 24)}` }
}

export async function verifyWebhookEndpoint(
  record: McpWebhookSubscriptionRecord,
  context: McpInvocationContext,
  options: NonNullable<NormalizedMcpEventsOptions['webhook']>,
  scope?: McpWebhookVerificationScope
): Promise<void> {
  const state = verificationState(options, scope)
  const endpoint = parseWebhookUrl(record.url)
  const cacheKey = `${record.principal}\0${record.url}`
  const now = Date.now()
  pruneCache(state.verifiedEndpoints, now)
  pruneCache(state.lastChallenge, now)
  if (record.verified || (state.verifiedEndpoints.get(cacheKey) ?? 0) > now) {
    await resolveForVerification(endpoint, options, context.signal)
    return
  }
  const allowlisted = (await options.allowlist?.(endpoint, context)) ?? false
  if (allowlisted) {
    await resolveForVerification(endpoint, options, context.signal)
    setBounded(state, state.verifiedEndpoints, cacheKey, now + options.verificationTtlMs)
    return
  }
  const previous = state.lastChallenge.get(cacheKey) ?? 0
  if (previous > now) throw new McpWebhookVerificationError('challenge_failed')
  setBounded(state, state.lastChallenge, cacheKey, now + options.challengeRateLimitMs)
  const challenge = randomBytes(24).toString('base64url')
  const expiresAt = now + options.challengeTtlMs
  const body = Buffer.from(JSON.stringify({ type: 'verification', challenge }))
  const response = await sendWebhookAttempt(
    record,
    body,
    `msg_verification_${randomBytes(12).toString('base64url')}`,
    options,
    context.signal
  )
  if (Date.now() > expiresAt || response.status < 200 || response.status >= 300)
    throw new McpWebhookVerificationError('challenge_failed')
  let echoed: unknown
  try {
    echoed = JSON.parse(Buffer.from(response.body).toString('utf8'))
  } catch {
    throw new McpWebhookVerificationError('challenge_failed')
  }
  const received =
    echoed && typeof echoed === 'object' && 'challenge' in echoed
      ? (echoed as { challenge?: unknown }).challenge
      : undefined
  if (typeof received !== 'string' || !constantTimeStringEqual(received, challenge))
    throw new McpWebhookVerificationError('challenge_failed')
  setBounded(state, state.verifiedEndpoints, cacheKey, Date.now() + options.verificationTtlMs)
}

function verificationState(
  options: NonNullable<NormalizedMcpEventsOptions['webhook']>,
  scope?: McpWebhookVerificationScope
): WebhookVerificationState {
  if (!scope) {
    let state = STANDALONE_VERIFICATION_STATES.get(options)
    if (!state) {
      state = createVerificationState()
      STANDALONE_VERIFICATION_STATES.set(options, state)
    }
    return state
  }
  let byOptions = APP_VERIFICATION_STATES.get(scope.app)
  if (!byOptions) {
    byOptions = new WeakMap()
    APP_VERIFICATION_STATES.set(scope.app, byOptions)
  }
  let state = byOptions.get(scope.options)
  if (!state) {
    state = createVerificationState()
    byOptions.set(scope.options, state)
  }
  return state
}

function createVerificationState(): WebhookVerificationState {
  return { verifiedEndpoints: new Map(), lastChallenge: new Map() }
}

function pruneCache(cache: Map<string, number>, floor: number): void {
  for (const [key, expiresAt] of cache) if (expiresAt <= floor) cache.delete(key)
}

function setBounded(
  state: WebhookVerificationState,
  cache: Map<string, number>,
  key: string,
  value: number
): void {
  cache.delete(key)
  while (cache.size >= MAX_VERIFICATION_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
  cache.set(key, value)
  scheduleVerificationCleanup(state)
}

function scheduleVerificationCleanup(state: WebhookVerificationState): void {
  if (state.cleanupTimer) clearTimeout(state.cleanupTimer)
  const expiries = [...state.verifiedEndpoints.values(), ...state.lastChallenge.values()]
  if (expiries.length === 0) {
    state.cleanupTimer = undefined
    return
  }
  const nextExpiry = Math.min(...expiries)
  state.cleanupTimer = setTimeout(
    () => {
      state.cleanupTimer = undefined
      const now = Date.now()
      pruneCache(state.verifiedEndpoints, now)
      pruneCache(state.lastChallenge, now)
      scheduleVerificationCleanup(state)
    },
    verificationCleanupDelay(nextExpiry, Date.now())
  )
  state.cleanupTimer.unref?.()
}

function verificationCleanupDelay(expiresAt: number, now: number): number {
  return Math.min(Math.max(0, expiresAt - now), MAX_TIMER_DELAY_MS)
}

async function resolveForVerification(
  endpoint: URL,
  options: NonNullable<NormalizedMcpEventsOptions['webhook']>,
  signal?: AbortSignal
): Promise<void> {
  if (signal?.aborted) throw new McpWebhookNetworkError('timeout')
  const controller = new AbortController()
  const relay = () => controller.abort(signal?.reason)
  signal?.addEventListener('abort', relay, { once: true })
  const timer = setTimeout(
    () => controller.abort('Webhook resolution timeout'),
    options.requestTimeoutMs
  )
  try {
    await Promise.race([
      resolveWebhookEndpoint(endpoint, options),
      new Promise<never>((_, reject) => {
        const fail = () => reject(new McpWebhookNetworkError('timeout'))
        if (controller.signal.aborted) fail()
        else controller.signal.addEventListener('abort', fail, { once: true })
      })
    ])
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', relay)
  }
}

export async function deliverWebhook(
  record: McpWebhookSubscriptionRecord,
  bodyValue: Record<string, unknown>,
  messageId: string,
  options: NonNullable<NormalizedMcpEventsOptions['webhook']>,
  signal?: AbortSignal,
  authorizeAttempt?: () => boolean | Promise<boolean>
): Promise<McpWebhookDeliveryResult> {
  if (signal?.aborted) throw signal.reason ?? new Error('Webhook delivery cancelled')
  const body = Buffer.from(JSON.stringify(bodyValue))
  if (body.byteLength > options.maxRequestBytes)
    return { acknowledged: false, abandoned: true, lastError: 'http_4xx', attempts: 0 }
  const startedAt = Date.now()
  const state: DeliveryAttemptState = { attempts: 0, lastError: null }
  while (canAttemptDelivery(state, startedAt, options)) {
    const outcome = await performDeliveryAttempt(
      record,
      body,
      messageId,
      options,
      startedAt,
      state,
      signal,
      authorizeAttempt
    )
    if (outcome === 'acknowledged')
      return { acknowledged: true, abandoned: false, lastError: null, attempts: state.attempts }
    if (outcome === 'abandoned')
      return {
        acknowledged: false,
        abandoned: true,
        lastError: state.lastError,
        attempts: state.attempts
      }
    if (!(await waitForRetry(state, startedAt, options, signal))) break
  }
  if (signal?.aborted) throw signal.reason ?? new Error('Webhook delivery cancelled')
  return {
    acknowledged: false,
    abandoned: true,
    lastError: state.lastError,
    attempts: state.attempts
  }
}

interface DeliveryAttemptState {
  attempts: number
  lastError: McpWebhookLastError | null
}

function canAttemptDelivery(
  state: DeliveryAttemptState,
  startedAt: number,
  options: NonNullable<NormalizedMcpEventsOptions['webhook']>
): boolean {
  return state.attempts < options.maxAttempts && Date.now() - startedAt <= options.maxRetryElapsedMs
}

async function performDeliveryAttempt(
  record: McpWebhookSubscriptionRecord,
  body: Uint8Array,
  messageId: string,
  options: NonNullable<NormalizedMcpEventsOptions['webhook']>,
  startedAt: number,
  state: DeliveryAttemptState,
  signal?: AbortSignal,
  authorizeAttempt?: () => boolean | Promise<boolean>
): Promise<'acknowledged' | 'abandoned' | 'retry'> {
  state.attempts++
  try {
    return await sendAuthorizedDeliveryAttempt(
      record,
      body,
      messageId,
      options,
      startedAt,
      state,
      signal,
      authorizeAttempt
    )
  } catch (error) {
    if (error instanceof McpWebhookDeliveryRevokedError) throw error
    if (signal?.aborted) throw signal.reason ?? new Error('Webhook delivery cancelled')
    state.lastError = error instanceof McpWebhookNetworkError ? error.reason : 'connection_refused'
    return 'retry'
  }
}

async function sendAuthorizedDeliveryAttempt(
  record: McpWebhookSubscriptionRecord,
  body: Uint8Array,
  messageId: string,
  options: NonNullable<NormalizedMcpEventsOptions['webhook']>,
  startedAt: number,
  state: DeliveryAttemptState,
  signal?: AbortSignal,
  authorizeAttempt?: () => boolean | Promise<boolean>
): Promise<'acknowledged' | 'abandoned' | 'retry'> {
  if (authorizeAttempt && !(await authorizeAttempt())) throw new McpWebhookDeliveryRevokedError()
  const remaining = options.maxRetryElapsedMs - (Date.now() - startedAt)
  if (remaining <= 0) return 'abandoned'
  const response = await sendWebhookAttempt(
    record,
    body,
    messageId,
    { ...options, requestTimeoutMs: Math.min(options.requestTimeoutMs, remaining) },
    signal
  )
  return classifyDeliveryResponse(response.status, state)
}

function classifyDeliveryResponse(
  status: number,
  state: DeliveryAttemptState
): 'acknowledged' | 'abandoned' | 'retry' {
  if (status >= 200 && status < 300) return 'acknowledged'
  state.lastError = status >= 500 ? 'http_5xx' : 'http_4xx'
  return status === 410 || status === 413 ? 'abandoned' : 'retry'
}

async function waitForRetry(
  state: DeliveryAttemptState,
  startedAt: number,
  options: NonNullable<NormalizedMcpEventsOptions['webhook']>,
  signal?: AbortSignal
): Promise<boolean> {
  if (state.attempts >= options.maxAttempts) return false
  const delay = options.retryBaseMs * 2 ** (state.attempts - 1)
  if (Date.now() - startedAt + delay > options.maxRetryElapsedMs) return false
  await abortableDelay(delay, signal)
  return true
}

export function webhookControlMessageId(type: string): string {
  return `msg_${type}_${randomBytes(12).toString('base64url')}`
}

export class McpWebhookVerificationError extends Error {
  constructor(readonly reason: McpWebhookLastError) {
    super('Webhook endpoint verification failed')
  }
}

export class McpWebhookDeliveryRevokedError extends Error {
  constructor() {
    super('Webhook delivery authorization was revoked')
  }
}

async function sendWebhookAttempt(
  record: McpWebhookSubscriptionRecord,
  body: Uint8Array,
  messageId: string,
  options: Pick<
    McpEventWebhookOptions,
    'allowPrivateAddresses' | 'resolveAddresses' | 'requestTimeoutMs' | 'maxResponseBytes'
  >,
  signal?: AbortSignal
) {
  return postWebhook(
    parseWebhookUrl(record.url),
    body,
    createWebhookHeaders(record, body, messageId),
    options,
    signal
  )
}

export function createWebhookHeaders(
  record: McpWebhookSubscriptionRecord,
  body: Uint8Array,
  messageId: string,
  timestamp = String(Math.floor(Date.now() / 1000))
): Record<string, string> {
  const signatures = [record.secret]
  if (
    record.previousSecret &&
    record.previousSecretExpiresAt !== undefined &&
    record.previousSecretExpiresAt > Date.now()
  )
    signatures.push(record.previousSecret)
  const prefix = Buffer.from(`${messageId}.${timestamp}.`)
  const signed = Buffer.concat([prefix, body])
  const signature = signatures
    .map((secret) => {
      assertWebhookSecret(secret)
      return `v1,${createHmac('sha256', Buffer.from(secret.slice(6), 'base64'))
        .update(signed)
        .digest('base64')}`
    })
    .join(' ')
  return {
    'content-type': 'application/json',
    'webhook-id': messageId,
    'webhook-timestamp': timestamp,
    'webhook-signature': signature,
    'x-mcp-subscription-id': record.id
  }
}

function constantTimeStringEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left)
  const rightBytes = Buffer.from(right)
  return leftBytes.byteLength === rightBytes.byteLength && timingSafeEqual(leftBytes, rightBytes)
}
