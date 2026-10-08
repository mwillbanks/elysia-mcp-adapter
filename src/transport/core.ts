import { randomBytes } from 'node:crypto'
import type { McpAuthorizationContext } from '../extensions/auth/index.js'
import { isRecord } from '../internal.js'
import { isMcpInputResponse } from '../schema/content.js'
import type {
  McpCachePolicy,
  McpInputRequiredResult,
  McpInputResponses,
  McpInvocationContext,
  NormalizedMcpPluginOptions
} from '../types.js'
import { assertInputRequestCapabilities } from './input-request-validation.js'
import { McpProtocolError } from './protocol.js'
import {
  requestBinding,
  signEnvelope,
  variantKey,
  verifyEnvelope
} from './signed-envelope-codec.js'

function principalKey(authorization?: McpAuthorizationContext): string | undefined {
  const principal = authorization?.principal
  return principal
    ? JSON.stringify([
        principal.issuer ?? null,
        principal.subject ?? null,
        principal.clientId ?? null
      ])
    : undefined
}

export function parseInputResponses(
  params: Record<string, unknown>
): McpInputResponses | undefined {
  if (!('inputResponses' in params)) return undefined
  if (!isRecord(params.inputResponses)) {
    throw new McpProtocolError(-32602, 'inputResponses must be an object', 400)
  }
  const responses: Array<[string, McpInputResponses[string]]> = []
  for (const [key, value] of Object.entries(params.inputResponses)) {
    if (!isMcpInputResponse(value)) {
      throw new McpProtocolError(
        -32602,
        `inputResponses.${key} is not a valid MCP input response`,
        400
      )
    }
    responses.push([key, value])
  }
  return Object.fromEntries(responses)
}

export async function resolveRequestState(
  request: Request,
  requestState: unknown,
  method: string,
  params: Record<string, unknown>,
  authorization: McpAuthorizationContext | undefined,
  options: NormalizedMcpPluginOptions
): Promise<string | undefined> {
  if (requestState === undefined) return undefined
  if (typeof requestState !== 'string') {
    throw new McpProtocolError(-32602, 'requestState must be a string', 400)
  }
  const config = options.core.continuation
  if (!config) return requestState
  const envelope = verifyEnvelope(
    requestState,
    config.signingKey,
    'continuation',
    method,
    params,
    principalKey(authorization)
  )
  if (config.singleUse) {
    const accepted = await config.provider?.consume(envelope.id, {
      request,
      principalKey: envelope.principal,
      expiresAt: envelope.exp
    })
    if (!accepted) throw new McpProtocolError(-32602, 'Continuation was already consumed', 400)
  }
  return envelope.value
}

export function prepareInputRequiredResult(
  value: unknown,
  method: string,
  params: Record<string, unknown>,
  context: McpInvocationContext,
  options: NormalizedMcpPluginOptions
): unknown {
  if (!isInputRequiredResult(value)) return value
  if (method !== 'tools/call' && method !== 'resources/read' && method !== 'prompts/get') {
    throw new McpProtocolError(-32603, `Input-required results are not valid for ${method}`)
  }
  if (value.inputRequests !== undefined && !isRecord(value.inputRequests)) {
    throw new McpProtocolError(-32603, 'Input-required inputRequests must be an object')
  }
  if (value.requestState !== undefined && typeof value.requestState !== 'string') {
    throw new McpProtocolError(-32603, 'Input-required requestState must be a string')
  }
  if (value._meta !== undefined && !isRecord(value._meta)) {
    throw new McpProtocolError(-32603, 'Input-required _meta must be an object')
  }
  if (!value.inputRequests && value.requestState === undefined) {
    throw new McpProtocolError(
      -32603,
      'Input-required results require inputRequests or requestState'
    )
  }
  if (value.inputRequests)
    assertInputRequestCapabilities(value.inputRequests, context.clientCapabilities)
  const config = options.core.continuation
  if (!config || value.requestState === undefined) return value
  return {
    ...value,
    requestState: signEnvelope(
      {
        v: 1,
        kind: 'continuation',
        id: randomBytes(18).toString('base64url'),
        exp: Date.now() + config.ttlMs,
        method,
        binding: requestBinding(method, params),
        principal: principalKey(context.authorization),
        variant: variantKey(params),
        value: value.requestState
      },
      config.signingKey
    )
  }
}

export function isInputRequiredResult(value: unknown): value is McpInputRequiredResult {
  return isRecord(value) && value.resultType === 'input_required'
}

export function encodeCursor(
  method: string,
  offset: number,
  params: Record<string, unknown>,
  context: McpInvocationContext,
  options: NormalizedMcpPluginOptions,
  pagination = options.core.pagination
): string {
  const config = pagination
  if (!config) throw new Error('Pagination is not configured')
  return signEnvelope(
    {
      v: 1,
      kind: 'cursor',
      id: randomBytes(12).toString('base64url'),
      exp: Date.now() + config.cursorTtlMs,
      method,
      binding: requestBinding(method, params, true),
      principal: principalKey(context.authorization),
      variant: variantKey(params),
      value: String(offset)
    },
    config.signingKey
  )
}

export function decodeCursor(
  cursor: unknown,
  method: string,
  params: Record<string, unknown>,
  context: McpInvocationContext,
  options: NormalizedMcpPluginOptions,
  pagination = options.core.pagination
): number {
  if (cursor === undefined) return 0
  if (typeof cursor !== 'string' || !pagination) {
    throw new McpProtocolError(-32602, 'Invalid pagination cursor', 400)
  }
  const envelope = verifyEnvelope(
    cursor,
    pagination.signingKey,
    'cursor',
    method,
    params,
    principalKey(context.authorization),
    true
  )
  const offset = Number(envelope.value)
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new McpProtocolError(-32602, 'Invalid pagination cursor', 400)
  }
  return offset
}

export async function cachePolicy(
  method: string,
  context: McpInvocationContext,
  options: NormalizedMcpPluginOptions
): Promise<McpCachePolicy> {
  const override = await options.core.cache.policy?.(method, context)
  const result = { ...options.core.cache.default, ...override }
  if (!Number.isSafeInteger(result.ttlMs) || result.ttlMs < 0) {
    throw new TypeError('Cache policy ttlMs must be a non-negative integer')
  }
  if (result.cacheScope !== 'private' && result.cacheScope !== 'public') {
    throw new TypeError('Cache policy cacheScope must be private or public')
  }
  return result
}

export function modernResultMeta(options: NormalizedMcpPluginOptions): Record<string, unknown> {
  return {
    'io.modelcontextprotocol/serverInfo': {
      name: options.server.name,
      version: options.server.version,
      ...(options.server.title ? { title: options.server.title } : {})
    }
  }
}
