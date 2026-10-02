import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { McpAuthorizationContext } from '../extensions/auth/index.js'
import { isRecord } from '../internal.js'
import { isMcpInputResponse, isSamplingContentValue } from '../schema/content.js'
import { isValidUri } from '../schema/validate.js'
import type {
  McpCachePolicy,
  McpInputRequest,
  McpInputRequiredResult,
  McpInputResponses,
  McpInvocationContext,
  NormalizedMcpPluginOptions
} from '../types.js'
import { McpProtocolError } from './protocol.js'

interface SignedEnvelope {
  v: 1
  kind: 'continuation' | 'cursor'
  id: string
  exp: number
  method: string
  binding: string
  principal?: string
  variant?: string
  value: string
}

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

function assertInputRequestCapabilities(
  requests: Record<string, McpInputRequest>,
  capabilities: Record<string, unknown> | undefined
): void {
  for (const [key, request] of Object.entries(requests)) {
    if (!isRecord(request) || typeof request.method !== 'string') {
      throw new McpProtocolError(-32603, `Invalid input request: ${key}`)
    }
    assertInputRequest(request, key)
    const capability =
      request.method === 'elicitation/create'
        ? 'elicitation'
        : request.method === 'sampling/createMessage'
          ? 'sampling'
          : request.method === 'roots/list'
            ? 'roots'
            : undefined
    const declared = capability ? capabilities?.[capability] : undefined
    const requiredCapabilities: Record<string, unknown> = capability ? { [capability]: {} } : {}
    if (
      request.method === 'elicitation/create' &&
      isRecord(request.params) &&
      (request.params.mode === undefined ||
        request.params.mode === 'form' ||
        request.params.mode === 'url')
    ) {
      requiredCapabilities.elicitation = { [request.params.mode === 'url' ? 'url' : 'form']: {} }
    }
    if (
      !capability ||
      !isRecord(declared) ||
      (request.method === 'elicitation/create' &&
        isRecord(request.params) &&
        (request.params.mode === undefined ||
          request.params.mode === 'form' ||
          request.params.mode === 'url') &&
        !supportsElicitationMode(declared, request.params.mode === 'url' ? 'url' : 'form'))
    ) {
      throw new McpProtocolError(
        -32021,
        `Missing required client capability: ${capability ?? request.method}`,
        400,
        {
          requiredCapabilities
        }
      )
    }
    if (request.method !== 'roots/list' && !isRecord(request.params)) {
      throw new McpProtocolError(-32603, `Input request ${key} requires params`)
    }
    const samplingUsesTools =
      request.method === 'sampling/createMessage' &&
      isRecord(request.params) &&
      (request.params.tools !== undefined || request.params.toolChoice !== undefined)
    if (samplingUsesTools && (!isRecord(declared) || !isRecord(declared.tools))) {
      throw new McpProtocolError(
        -32021,
        'Missing required client capability: sampling.tools',
        400,
        {
          requiredCapabilities: { sampling: { tools: {} } }
        }
      )
    }
    if (
      request.method === 'sampling/createMessage' &&
      isRecord(request.params) &&
      request.params.includeContext !== undefined &&
      request.params.includeContext !== 'none' &&
      (!isRecord(declared) || !isRecord(declared.context))
    ) {
      throw new McpProtocolError(
        -32021,
        'Missing required client capability: sampling.context',
        400,
        {
          requiredCapabilities: { sampling: { context: {} } }
        }
      )
    }
  }
}

function supportsElicitationMode(
  capability: Record<string, unknown>,
  mode: 'form' | 'url'
): boolean {
  if (mode === 'url') return isRecord(capability.url)
  if (isRecord(capability.form)) return true
  return capability.form === undefined && capability.url === undefined
}

function assertInputRequest(request: Record<string, unknown>, key: string): void {
  const params = request.params
  if (request.method === 'roots/list') {
    if (params !== undefined && !isRecord(params)) invalidInputRequest(key)
    return
  }
  if (!isRecord(params)) invalidInputRequest(key)
  if (request.method === 'elicitation/create') {
    if (typeof params.message !== 'string') invalidInputRequest(key)
    if (params.mode === 'url') {
      if (!isValidUri(params.url)) invalidInputRequest(key)
      return
    }
    if (params.mode !== undefined && params.mode !== 'form') invalidInputRequest(key)
    if (
      !isRecord(params.requestedSchema) ||
      params.requestedSchema.type !== 'object' ||
      !isRecord(params.requestedSchema.properties) ||
      !Object.values(params.requestedSchema.properties).every(isPrimitiveElicitationSchema) ||
      (params.requestedSchema.required !== undefined &&
        (!Array.isArray(params.requestedSchema.required) ||
          !params.requestedSchema.required.every((value) => typeof value === 'string'))) ||
      (params.requestedSchema.$schema !== undefined &&
        typeof params.requestedSchema.$schema !== 'string')
    ) {
      invalidInputRequest(key)
    }
    return
  }
  if (request.method === 'sampling/createMessage') {
    if (
      !Array.isArray(params.messages) ||
      !params.messages.every(
        (message) =>
          isRecord(message) &&
          (message.role === 'user' || message.role === 'assistant') &&
          isSamplingContentValue(message.content)
      ) ||
      !Number.isSafeInteger(params.maxTokens) ||
      (params.systemPrompt !== undefined && typeof params.systemPrompt !== 'string') ||
      (params.includeContext !== undefined &&
        params.includeContext !== 'none' &&
        params.includeContext !== 'thisServer' &&
        params.includeContext !== 'allServers') ||
      (params.temperature !== undefined &&
        (typeof params.temperature !== 'number' || !Number.isFinite(params.temperature))) ||
      (params.stopSequences !== undefined &&
        (!Array.isArray(params.stopSequences) ||
          !params.stopSequences.every((value) => typeof value === 'string'))) ||
      (params.metadata !== undefined && !isRecord(params.metadata)) ||
      !isModelPreferences(params.modelPreferences) ||
      !isSamplingTools(params.tools) ||
      !isToolChoice(params.toolChoice)
    ) {
      invalidInputRequest(key)
    }
    return
  }
  invalidInputRequest(key)
}

function isPrimitiveElicitationSchema(value: unknown): boolean {
  if (
    !isRecord(value) ||
    'properties' in value ||
    (value.title !== undefined && typeof value.title !== 'string') ||
    (value.description !== undefined && typeof value.description !== 'string')
  ) {
    return false
  }
  if (value.type === 'boolean') {
    return value.default === undefined || typeof value.default === 'boolean'
  }
  if (value.type === 'number' || value.type === 'integer') {
    return (
      isOptionalFiniteNumber(value.default) &&
      isOptionalFiniteNumber(value.minimum) &&
      isOptionalFiniteNumber(value.maximum)
    )
  }
  if (value.type === 'string') return isPrimitiveStringSchema(value)
  if (value.type === 'array') return isPrimitiveArraySchema(value)
  return false
}

function isPrimitiveStringSchema(value: Record<string, unknown>): boolean {
  if (value.default !== undefined && typeof value.default !== 'string') return false
  if (value.enum !== undefined) {
    return (
      isStringArray(value.enum) && (value.enumNames === undefined || isStringArray(value.enumNames))
    )
  }
  if (value.oneOf !== undefined) return isTitledEnumChoices(value.oneOf)
  return (
    (value.format === undefined ||
      value.format === 'date' ||
      value.format === 'date-time' ||
      value.format === 'email' ||
      value.format === 'uri') &&
    isOptionalSafeInteger(value.minLength) &&
    isOptionalSafeInteger(value.maxLength)
  )
}

function isPrimitiveArraySchema(value: Record<string, unknown>): boolean {
  if (
    !isRecord(value.items) ||
    (value.default !== undefined && !isStringArray(value.default)) ||
    !isOptionalSafeInteger(value.minItems) ||
    !isOptionalSafeInteger(value.maxItems)
  ) {
    return false
  }
  if (value.items.enum !== undefined) {
    return value.items.type === 'string' && isStringArray(value.items.enum)
  }
  return isTitledEnumChoices(value.items.anyOf)
}

function isTitledEnumChoices(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every(
      (choice) =>
        isRecord(choice) && typeof choice.const === 'string' && typeof choice.title === 'string'
    )
  )
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
}

function isOptionalFiniteNumber(value: unknown): boolean {
  return value === undefined || (typeof value === 'number' && Number.isFinite(value))
}

function isOptionalSafeInteger(value: unknown): boolean {
  return value === undefined || Number.isSafeInteger(value)
}

function isModelPreferences(value: unknown): boolean {
  if (value === undefined) return true
  if (!isRecord(value)) return false
  if (
    value.hints !== undefined &&
    (!Array.isArray(value.hints) ||
      !value.hints.every(
        (hint) => isRecord(hint) && (hint.name === undefined || typeof hint.name === 'string')
      ))
  ) {
    return false
  }
  return ['costPriority', 'speedPriority', 'intelligencePriority'].every((key) => {
    const priority = value[key]
    return (
      priority === undefined ||
      (typeof priority === 'number' && Number.isFinite(priority) && priority >= 0 && priority <= 1)
    )
  })
}

function isSamplingTools(value: unknown): boolean {
  if (value === undefined) return true
  return (
    Array.isArray(value) &&
    value.every(
      (tool) =>
        isRecord(tool) &&
        typeof tool.name === 'string' &&
        isRecord(tool.inputSchema) &&
        tool.inputSchema.type === 'object'
    )
  )
}

function isToolChoice(value: unknown): boolean {
  return (
    value === undefined ||
    (isRecord(value) &&
      (value.mode === undefined ||
        value.mode === 'auto' ||
        value.mode === 'required' ||
        value.mode === 'none'))
  )
}

function invalidInputRequest(key: string): never {
  throw new McpProtocolError(-32603, `Invalid input request: ${key}`)
}

function signEnvelope(envelope: SignedEnvelope, key: string | Uint8Array): string {
  const body = Buffer.from(JSON.stringify(envelope)).toString('base64url')
  const signature = createHmac('sha256', key).update(body).digest('base64url')
  return `${body}.${signature}`
}

function verifyEnvelope(
  token: string,
  key: string | Uint8Array,
  kind: SignedEnvelope['kind'],
  method: string,
  params: Record<string, unknown>,
  principal: string | undefined,
  ignoreCursor = false
): SignedEnvelope {
  const [body, suppliedSignature, ...rest] = token.split('.')
  if (!body || !suppliedSignature || rest.length > 0) return invalidEnvelope(kind)
  const expected = createHmac('sha256', key).update(body).digest()
  let supplied: Buffer
  try {
    supplied = Buffer.from(suppliedSignature, 'base64url')
  } catch {
    return invalidEnvelope(kind)
  }
  if (supplied.byteLength !== expected.byteLength || !timingSafeEqual(supplied, expected)) {
    return invalidEnvelope(kind)
  }
  let envelope: unknown
  try {
    envelope = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
  } catch {
    return invalidEnvelope(kind)
  }
  if (!isSignedEnvelope(envelope, kind)) return invalidEnvelope(kind)
  if (envelope.exp <= Date.now()) throw new McpProtocolError(-32602, `${kind} expired`, 400)
  if (
    envelope.method !== method ||
    envelope.binding !== requestBinding(method, params, ignoreCursor) ||
    envelope.principal !== principal ||
    envelope.variant !== variantKey(params)
  ) {
    throw new McpProtocolError(-32602, `${kind} does not match this request`, 400)
  }
  return envelope
}

function invalidEnvelope(kind: SignedEnvelope['kind']): never {
  throw new McpProtocolError(-32602, `Invalid ${kind}`, 400)
}

function isSignedEnvelope(value: unknown, kind: SignedEnvelope['kind']): value is SignedEnvelope {
  return (
    isRecord(value) &&
    value.v === 1 &&
    value.kind === kind &&
    typeof value.id === 'string' &&
    typeof value.exp === 'number' &&
    typeof value.method === 'string' &&
    typeof value.binding === 'string' &&
    typeof value.value === 'string' &&
    (value.principal === undefined || typeof value.principal === 'string') &&
    (value.variant === undefined || typeof value.variant === 'string')
  )
}

function requestBinding(
  method: string,
  params: Record<string, unknown>,
  ignoreCursor = false
): string {
  const salient = Object.fromEntries(
    Object.entries(params).filter(
      ([key]) =>
        key !== '_meta' &&
        key !== 'inputResponses' &&
        key !== 'requestState' &&
        (!ignoreCursor || key !== 'cursor')
    )
  )
  return createHmac('sha256', 'mcp-request-binding')
    .update(stableJson([method, salient]))
    .digest('base64url')
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function variantKey(params: Record<string, unknown>): string | undefined {
  const meta = isRecord(params._meta) ? params._meta : undefined
  const value = meta?.['io.modelcontextprotocol/server-variant']
  return typeof value === 'string' ? value : undefined
}
