import {
  assertMcpAppsResourceContent,
  assertMcpAppsResourceMetadata,
  assertMcpAppsResourceUri,
  assertMcpAppsToolMetadata,
  MCP_APPS_EXTENSION_ID,
  MCP_APPS_RESOURCE_MIME_TYPE,
  MCP_APPS_RESOURCE_URI_META_KEY,
  normalizeMcpAppsToolMetadata,
  resolveMcpAppsResourceMeta
} from '../extensions/apps/index.js'
import {
  authorizeBearerRequest,
  buildBearerChallenge,
  type McpAuthorizationContext,
  missingRequiredScopes,
  protectedResourceMetadataUrl
} from '../extensions/auth/index.js'
import { McpExtensionDispatcher } from '../extensions/dispatcher.js'
import {
  listEvents,
  McpEventProtocolError,
  pollEvents,
  streamEvents,
  subscribeEventsWebhook,
  unsubscribeEventsWebhook
} from '../extensions/events/index.js'
import {
  interceptorMatches,
  invokeInterceptor,
  McpInterceptorExecutionError,
  McpInterceptorTimeoutError
} from '../extensions/interceptors/index.js'
import { MCP_EXTENSION_SUPPORT } from '../extensions/manifest.js'
import {
  dispatchTaskRequest,
  hasTasksCapability,
  setTaskController,
  TaskController,
  TaskProtocolError
} from '../extensions/tasks/index.js'
import { MCP_SERVER_VARIANT_META_KEY, type McpServerVariant } from '../extensions/variants/index.js'
import { isRecord } from '../internal.js'
import { findResourceReader, getMcpRegistry } from '../registry.js'
import { ensureMcpState } from '../state.js'
import type {
  AnyElysiaApp,
  JsonRpcRequest,
  JsonRpcResponse,
  McpAuthorizationOptions,
  McpInvocationContext,
  McpPromptDefinition,
  McpResourceDefinition,
  McpResourceTemplateDefinition,
  McpToolDefinition,
  NormalizedMcpPluginOptions
} from '../types.js'
import {
  decodeCursor,
  encodeCursor,
  isInputRequiredResult,
  parseInputResponses,
  resolveRequestState
} from './core.js'
import {
  type DiscoveryRuntime,
  initializedSessionId,
  initializeResult,
  modernDiscoverResult
} from './discovery.js'
import { exceedsInputElementLimit } from './input-limits.js'
import { invocationContextBase } from './invocation-context.js'
import { handleLegacyAuxiliaryMethod, type LegacySessionRuntime } from './legacy-sessions.js'
import { assertMirroredToolHeaders, assertValidMirroredHeaderSchema } from './mirrored-headers.js'
import { isOriginAllowed } from './origin-policy.js'
import {
  McpProtocolError,
  type McpRequestProtocolContext,
  resolveRequestProtocol
} from './protocol.js'
import { isRequestId } from './request-id.js'
import { type ResultSerializationRuntime, serializeProtocolResult } from './result-serialization.js'
import {
  getSkill,
  listSkills,
  readSkillDirectory,
  readSkillResource,
  type SkillRequestRuntime
} from './skill-requests.js'
import { handleSubscription, linkAbortSignal, sseResponse } from './subscriptions.js'
import {
  resolveActiveVariant,
  type VariantSelectionRuntime,
  variantAllows,
  variantPrincipal
} from './variant-selection.js'
import {
  subscribeVariantResource,
  unsubscribeVariantResource,
  type VariantSubscriptionRuntime
} from './variant-subscriptions.js'

const JSON_RPC_VERSION = '2.0' as const

interface DispatchContext {
  protocol: McpRequestProtocolContext
  authorization?: McpAuthorizationContext
  signal?: AbortSignal
  reportProgress?: McpInvocationContext['reportProgress']
  activeVariant?: McpServerVariant
  sessionId?: string
}

interface RpcOutcome {
  response?: JsonRpcResponse
  status: number
}

const SKILL_REQUEST_RUNTIME: SkillRequestRuntime = {
  invocationContext,
  enforceAuthorization,
  isAuthorized,
  error: (code, message, data, status) => new JsonRpcError(code, message, data, status)
}

const VARIANT_SUBSCRIPTION_RUNTIME: VariantSubscriptionRuntime = {
  invocationContext,
  authorizeRequest,
  enforceAuthorization,
  isAuthorized,
  variantAllows: (variant, kind, name) => variantAllows(variant, kind, name),
  variantPrincipal,
  error: (code, message, data) => new JsonRpcError(code, message, data)
}

const VARIANT_SELECTION_RUNTIME: VariantSelectionRuntime = {
  error: (code, message, data) => new JsonRpcError(code, message, data)
}

const DISCOVERY_RUNTIME: DiscoveryRuntime = {
  ...VARIANT_SELECTION_RUNTIME,
  interceptorCapabilities
}

const RESULT_SERIALIZATION_RUNTIME: ResultSerializationRuntime = {
  error: (code, message) => new JsonRpcError(code, message)
}

const LEGACY_SESSION_RUNTIME: LegacySessionRuntime = {
  errorResponse: createErrorResponse,
  jsonResponse
}

export async function handleMcpHttpRequest(
  app: AnyElysiaApp,
  request: Request,
  options: NormalizedMcpPluginOptions
): Promise<Response> {
  const originValidation = validateOrigin(request, options)
  if (originValidation) return originValidation
  const protocolFailure = validateProtocolHeader(request, options)
  if (protocolFailure) return protocolFailure
  const authorization = await authorizeRequest(request, options)
  if (authorization instanceof Response) return authorization
  return handleAuthorizedHttpRequest(app, request, options, authorization)
}

async function handleAuthorizedHttpRequest(
  app: AnyElysiaApp,
  request: Request,
  options: NormalizedMcpPluginOptions,
  authorization: McpAuthorizationContext | undefined
): Promise<Response> {
  if (request.method === 'GET' || request.method === 'DELETE') {
    return handleAuxiliaryHttpRequest(app, request, options, authorization)
  }
  if (request.method !== 'POST') return methodNotAllowedResponse()
  const parsed = await readRequestPayload(request, options)
  if (parsed instanceof Response) return parsed
  return handlePostPayload(app, parsed.payload, request, options, authorization)
}

async function readRequestPayload(
  request: Request,
  options: NormalizedMcpPluginOptions
): Promise<{ payload: unknown } | Response> {
  try {
    return { payload: await request.json() }
  } catch (error) {
    return parseErrorResponse(request, options, error)
  }
}

function handleAuxiliaryHttpRequest(
  app: AnyElysiaApp,
  request: Request,
  options: NormalizedMcpPluginOptions,
  authorization: McpAuthorizationContext | undefined
): Promise<Response> | Response {
  if (usesModernErrorEnvelope(request, options)) {
    return jsonResponse(createErrorResponse(undefined, -32600, 'Modern MCP is POST-only'), 405)
  }
  return handleLegacyAuxiliaryMethod(app, request, options, authorization, LEGACY_SESSION_RUNTIME)
}

async function handlePostPayload(
  app: AnyElysiaApp,
  payload: unknown,
  request: Request,
  options: NormalizedMcpPluginOptions,
  authorization: McpAuthorizationContext | undefined
): Promise<Response> {
  if (Array.isArray(payload)) {
    return handleBatchPayload(app, payload, request, options, authorization)
  }
  if (isRecord(payload) && payload.method === 'subscriptions/listen') {
    return handleSubscription(
      app,
      payload as unknown as JsonRpcRequest,
      request,
      options,
      authorization
    )
  }
  if (isRecord(payload) && payload.method === 'events/stream') {
    return handleEventStreamRequest(
      app,
      payload as unknown as JsonRpcRequest,
      request,
      options,
      authorization
    )
  }
  if (isProgressRequest(payload)) {
    return handleProgressRequest(
      app,
      payload as unknown as JsonRpcRequest,
      request,
      options,
      authorization
    )
  }
  const outcome = await handleJsonRpcMessage(app, payload, request, options, authorization)
  return outcomeResponse(outcome, request, options)
}

async function handleBatchPayload(
  app: AnyElysiaApp,
  payload: unknown[],
  request: Request,
  options: NormalizedMcpPluginOptions,
  authorization: McpAuthorizationContext | undefined
): Promise<Response> {
  if (usesModernErrorEnvelope(request, options)) {
    return jsonResponse(
      createErrorResponse(undefined, -32600, 'Modern MCP does not support batches'),
      400
    )
  }
  const responses: JsonRpcResponse[] = []
  for (const item of payload) {
    const outcome = await handleJsonRpcMessage(app, item, request, options, authorization)
    if (outcome.response) responses.push(outcome.response)
  }
  return responses.length === 0 ? new Response(null, { status: 202 }) : jsonResponse(responses)
}

async function handleEventStreamRequest(
  app: AnyElysiaApp,
  eventRequest: JsonRpcRequest,
  request: Request,
  options: NormalizedMcpPluginOptions,
  authorization: McpAuthorizationContext | undefined
): Promise<Response> {
  const validation = validateEventStreamRequest(eventRequest, options)
  if (validation) return validation
  try {
    const protocol = resolveRequestProtocol(request, eventRequest, options)
    if (protocol.modern) {
      throw new McpEventProtocolError(-32601, 'Events extension is legacy-only', undefined, 404)
    }
    const params = isRecord(eventRequest.params) ? eventRequest.params : {}
    const dispatch: DispatchContext = { protocol, authorization }
    await selectEventStreamVariant(app, request, params, options, dispatch)
    return await streamEvents(
      app,
      params,
      eventRequest.id as string | number,
      options,
      await invocationContext(request, 'events/stream', params, dispatch, options)
    )
  } catch (error) {
    return jsonResponse(normalizeDispatchError(eventRequest.id, error), errorStatus(error))
  }
}

function validateEventStreamRequest(
  eventRequest: JsonRpcRequest,
  options: NormalizedMcpPluginOptions
): Response | undefined {
  if (!options.extensions.events) {
    return jsonResponse(
      createErrorResponse(eventRequest.id, -32601, 'Events extension is not enabled'),
      404
    )
  }
  if (!isRequestId(eventRequest.id)) {
    return jsonResponse(createErrorResponse(undefined, -32600, 'Invalid Request'), 400)
  }
  return undefined
}

async function selectEventStreamVariant(
  app: AnyElysiaApp,
  request: Request,
  params: Record<string, unknown>,
  options: NormalizedMcpPluginOptions,
  dispatch: DispatchContext
): Promise<void> {
  if (!options.extensions.variants) return
  const selected = await resolveActiveVariant(
    app,
    request,
    params,
    options,
    dispatch.authorization,
    VARIANT_SELECTION_RUNTIME
  )
  dispatch.activeVariant = selected.variant
  dispatch.sessionId = selected.sessionId
  const meta = isRecord(params._meta) ? { ...params._meta } : {}
  meta[MCP_SERVER_VARIANT_META_KEY] = selected.variant.id
  params._meta = meta
}

function outcomeResponse(
  outcome: RpcOutcome,
  request: Request,
  options: NormalizedMcpPluginOptions
): Response {
  if (!outcome.response) return new Response(null, { status: 202 })
  return jsonResponse(outcome.response, outcome.status, outcomeHeaders(outcome, request, options))
}

function outcomeHeaders(
  outcome: RpcOutcome,
  request: Request,
  options: NormalizedMcpPluginOptions
): HeadersInit {
  const headers: Record<string, string> = {}
  const session = initializedSessionId(request)
  if (session) headers['mcp-session-id'] = session
  if (outcome.status === 403 && options.extensions.auth) {
    headers['www-authenticate'] = buildBearerChallenge({
      resourceMetadata: protectedResourceMetadataUrl(options.extensions.auth.resource),
      error: 'insufficient_scope',
      scope: requiredScopesFromOutcome(outcome)
    })
  }
  return headers
}

function requiredScopesFromOutcome(outcome: RpcOutcome): string[] | undefined {
  const data = outcome.response?.error?.data
  if (!isRecord(data) || !Array.isArray(data.requiredScopes)) return undefined
  return data.requiredScopes.filter((scope): scope is string => typeof scope === 'string')
}

function validateProtocolHeader(
  request: Request,
  options: NormalizedMcpPluginOptions
): Response | undefined {
  const protocol = request.headers.get('mcp-protocol-version')
  if (protocol === null || options.transport.protocolVersions.includes(protocol as never)) {
    return undefined
  }
  return jsonResponse(
    {
      jsonrpc: JSON_RPC_VERSION,
      error: {
        code: -32022,
        message: `Unsupported protocol version: ${protocol}`,
        data: { supported: options.transport.protocolVersions, requested: protocol }
      }
    },
    400
  )
}

function parseErrorResponse(
  request: Request,
  options: NormalizedMcpPluginOptions,
  error: unknown
): Response {
  return jsonResponse(
    createErrorResponse(
      errorIdForRequest(request, options),
      -32700,
      'Parse error',
      error instanceof Error ? error.message : undefined
    ),
    400
  )
}

function methodNotAllowedResponse(): Response {
  return new Response(null, { status: 405, headers: { allow: 'POST, GET, DELETE' } })
}

async function handleJsonRpcMessage(
  app: AnyElysiaApp,
  payload: unknown,
  request: Request,
  options: NormalizedMcpPluginOptions,
  authorization?: McpAuthorizationContext,
  overrides: Pick<DispatchContext, 'signal' | 'reportProgress'> = {}
): Promise<RpcOutcome> {
  const validation = validateJsonRpcMessage(payload, request, options)
  if ('outcome' in validation) return validation.outcome
  return executeJsonRpcMessage(app, validation.payload, request, options, authorization, overrides)
}

function validateJsonRpcMessage(
  payload: unknown,
  request: Request,
  options: NormalizedMcpPluginOptions
): { payload: JsonRpcRequest } | { outcome: RpcOutcome } {
  if (!isJsonRpcRequest(payload)) {
    return {
      outcome: {
        response: createErrorResponse(
          errorIdForRequest(request, options, payload),
          -32600,
          'Invalid Request'
        ),
        status: 400
      }
    }
  }
  if (
    usesModernErrorEnvelope(request, options) &&
    payload.id !== undefined &&
    !isRequestId(payload.id)
  ) {
    return {
      outcome: {
        response: createErrorResponse(undefined, -32600, 'Invalid Request'),
        status: 400
      }
    }
  }
  return { payload }
}

async function executeJsonRpcMessage(
  app: AnyElysiaApp,
  payload: JsonRpcRequest,
  request: Request,
  options: NormalizedMcpPluginOptions,
  authorization: McpAuthorizationContext | undefined,
  overrides: Pick<DispatchContext, 'signal' | 'reportProgress'>
): Promise<RpcOutcome> {
  const id = payload.id ?? null
  const errorId = errorIdForRequest(request, options, payload)
  try {
    const protocol = resolveRequestProtocol(request, payload, options)
    if (payload.id === undefined || payload.id === null) return { status: 202 }
    const result = await dispatchRequest(app, payload, request, options, {
      protocol,
      authorization,
      ...overrides
    })
    return {
      response: {
        jsonrpc: JSON_RPC_VERSION,
        id,
        result: await serializeProtocolResult(
          payload.method ?? '',
          result,
          protocol,
          payload.params ?? {},
          invocationContextBase(request, payload.params ?? {}, { protocol, authorization }),
          options,
          RESULT_SERIALIZATION_RUNTIME
        )
      },
      status: 200
    }
  } catch (error) {
    return {
      response: normalizeDispatchError(errorId, error),
      status: errorStatus(error)
    }
  }
}

async function dispatchRequest(
  app: AnyElysiaApp,
  payload: JsonRpcRequest,
  request: Request,
  options: NormalizedMcpPluginOptions,
  context: DispatchContext
): Promise<unknown> {
  const method = payload.method ?? ''
  const params = isRecord(payload.params) ? payload.params : {}
  await applyRequestVariant(app, method, params, request, options, context)
  const extensionResult = await extensionDispatcher(options, context).dispatch(method, {
    request,
    params
  })
  if (extensionResult.handled) return extensionResult.result
  return dispatchBuiltinRequest(app, method, params, request, options, context)
}

async function applyRequestVariant(
  app: AnyElysiaApp,
  method: string,
  params: Record<string, unknown>,
  request: Request,
  options: NormalizedMcpPluginOptions,
  context: DispatchContext
): Promise<void> {
  if (options.extensions.variants && method !== 'initialize') {
    const selected = await resolveActiveVariant(
      app,
      request,
      params,
      options,
      context.authorization,
      VARIANT_SELECTION_RUNTIME
    )
    context.activeVariant = selected.variant
    context.sessionId = selected.sessionId
    const meta = isRecord(params._meta) ? { ...params._meta } : {}
    meta[MCP_SERVER_VARIANT_META_KEY] = selected.variant.id
    params._meta = meta
  } else if (
    !options.extensions.variants &&
    ((isRecord(params._meta) && params._meta[MCP_SERVER_VARIANT_META_KEY] !== undefined) ||
      request.headers.has('mcp-server-variant'))
  ) {
    throw new JsonRpcError(-32602, 'Server variants not supported')
  }
}

async function dispatchBuiltinRequest(
  app: AnyElysiaApp,
  method: string,
  params: Record<string, unknown>,
  request: Request,
  options: NormalizedMcpPluginOptions,
  context: DispatchContext
): Promise<unknown> {
  switch (method) {
    case 'initialize':
      if (context.protocol.modern)
        throw new JsonRpcError(-32601, 'Method not found: initialize', undefined, 404)
      return initializeResult(
        app,
        request,
        params,
        options,
        context.authorization,
        DISCOVERY_RUNTIME
      )
    case 'server/discover':
      if (!context.protocol.modern) {
        throw new JsonRpcError(-32601, 'Method not found: server/discover', undefined, 404)
      }
      return modernDiscoverResult(app, options, DISCOVERY_RUNTIME)
    case 'ping':
      if (context.protocol.modern) {
        throw new JsonRpcError(-32601, 'Method not found: ping', undefined, 404)
      }
      return {}
    default:
      return dispatchPrimitiveRequest(app, method, params, request, options, context)
  }
}

function dispatchPrimitiveRequest(
  app: AnyElysiaApp,
  method: string,
  params: Record<string, unknown>,
  request: Request,
  options: NormalizedMcpPluginOptions,
  context: DispatchContext
): Promise<unknown> | unknown {
  const domain = method.split('/')[0]
  if (domain === 'tools') return dispatchToolRequest(app, method, params, request, options, context)
  if (domain === 'resources') {
    return dispatchResourceRequest(app, method, params, request, options, context)
  }
  if (domain === 'skills')
    return dispatchSkillRequest(app, method, params, request, options, context)
  if (domain === 'interceptors' || domain === 'interceptor') {
    return dispatchInterceptorRequest(app, method, params, request, options, context)
  }
  if (domain === 'events')
    return dispatchEventRequest(app, method, params, request, options, context)
  if (domain === 'prompts')
    return dispatchPromptRequest(app, method, params, request, options, context)
  if (domain === 'completion') {
    return dispatchCompletionRequest(app, method, params, request, options, context)
  }
  throw methodNotFound(method, context)
}

function dispatchToolRequest(
  app: AnyElysiaApp,
  method: string,
  params: Record<string, unknown>,
  request: Request,
  options: NormalizedMcpPluginOptions,
  context: DispatchContext
): Promise<unknown> | unknown {
  if (method === 'tools/list') return listTools(app, params, request, options, context)
  if (method === 'tools/call') return callTool(app, params, request, options, context)
  throw methodNotFound(method, context)
}

function dispatchResourceRequest(
  app: AnyElysiaApp,
  method: string,
  params: Record<string, unknown>,
  request: Request,
  options: NormalizedMcpPluginOptions,
  context: DispatchContext
): Promise<unknown> | unknown {
  if (method === 'resources/list') return listResources(app, params, request, options, context)
  if (method === 'resources/templates/list') {
    return listResourceTemplates(app, params, request, options, context)
  }
  if (method === 'resources/read') return readResource(app, params, request, options, context)
  if (method === 'resources/directory/read') {
    return readSkillDirectory(app, params, request, options, context, SKILL_REQUEST_RUNTIME)
  }
  if (method === 'resources/subscribe') {
    return subscribeVariantResource(
      app,
      params,
      request,
      options,
      context,
      VARIANT_SUBSCRIPTION_RUNTIME
    )
  }
  if (method === 'resources/unsubscribe') {
    return unsubscribeVariantResource(app, params, options, context, VARIANT_SUBSCRIPTION_RUNTIME)
  }
  throw methodNotFound(method, context)
}

function dispatchSkillRequest(
  app: AnyElysiaApp,
  method: string,
  params: Record<string, unknown>,
  request: Request,
  options: NormalizedMcpPluginOptions,
  context: DispatchContext
): Promise<unknown> | unknown {
  if (method === 'skills/list') {
    return listSkills(app, params, request, options, context, SKILL_REQUEST_RUNTIME)
  }
  if (method === 'skills/get') {
    return getSkill(app, params, request, options, context, SKILL_REQUEST_RUNTIME)
  }
  throw methodNotFound(method, context)
}

function dispatchInterceptorRequest(
  app: AnyElysiaApp,
  method: string,
  params: Record<string, unknown>,
  request: Request,
  options: NormalizedMcpPluginOptions,
  context: DispatchContext
): Promise<unknown> | unknown {
  if (method === 'interceptors/list') return listInterceptors(app, params, options)
  if (method === 'interceptor/invoke') {
    return invokeRegisteredInterceptor(app, params, request, options, context)
  }
  throw methodNotFound(method, context)
}

async function dispatchEventRequest(
  app: AnyElysiaApp,
  method: string,
  params: Record<string, unknown>,
  request: Request,
  options: NormalizedMcpPluginOptions,
  context: DispatchContext
): Promise<unknown> {
  const known = new Set(['events/list', 'events/poll', 'events/subscribe', 'events/unsubscribe'])
  if (!known.has(method)) throw methodNotFound(method, context)
  const invocation = await invocationContext(request, method, params, context, options)
  if (method === 'events/list') return listEvents(app, params, request, options, invocation)
  if (method === 'events/poll') return pollEvents(app, params, options, invocation)
  if (method === 'events/subscribe') return subscribeEventsWebhook(app, params, options, invocation)
  return unsubscribeEventsWebhook(app, params, options, invocation)
}

function dispatchPromptRequest(
  app: AnyElysiaApp,
  method: string,
  params: Record<string, unknown>,
  request: Request,
  options: NormalizedMcpPluginOptions,
  context: DispatchContext
): Promise<unknown> | unknown {
  if (method === 'prompts/list') return listPrompts(app, params, request, options, context)
  if (method === 'prompts/get') return getPrompt(app, params, request, options, context)
  throw methodNotFound(method, context)
}

function dispatchCompletionRequest(
  app: AnyElysiaApp,
  method: string,
  params: Record<string, unknown>,
  request: Request,
  options: NormalizedMcpPluginOptions,
  context: DispatchContext
): Promise<unknown> {
  if (method !== 'completion/complete') throw methodNotFound(method, context)
  if (!context.protocol.modern && !options.extensions.variants) {
    throw new JsonRpcError(-32601, 'Method not found: completion/complete', undefined, 404)
  }
  return completeArgument(app, params, request, options, context)
}

function methodNotFound(method: string, context: DispatchContext): JsonRpcError {
  return new JsonRpcError(
    -32601,
    `Method not found: ${method}`,
    undefined,
    context.protocol.modern ? 404 : 200
  )
}

function listInterceptors(
  app: AnyElysiaApp,
  params: Record<string, unknown>,
  options: NormalizedMcpPluginOptions
): Record<string, unknown> {
  if (!options.extensions.interceptors) {
    throw new JsonRpcError(-32601, 'Method not found: interceptors/list', undefined, 404)
  }
  if (params.event !== undefined && typeof params.event !== 'string') {
    throw new JsonRpcError(-32602, 'Interceptor event filter must be a string')
  }
  const registrations = ensureMcpState(app).explicitInterceptors.values()
  return {
    interceptors: [...registrations]
      .filter(({ definition }) =>
        typeof params.event === 'string'
          ? definition.hooks.some((hook) =>
              hook.events.some((event) => event === '*' || event === params.event)
            )
          : true
      )
      .map(({ definition }) => definition)
  }
}

async function invokeRegisteredInterceptor(
  app: AnyElysiaApp,
  params: Record<string, unknown>,
  request: Request,
  options: NormalizedMcpPluginOptions,
  context: DispatchContext
): Promise<unknown> {
  assertInterceptorEnabled(options)
  const invocation = interceptorInvocation(params)
  const registration = ensureMcpState(app).explicitInterceptors.get(invocation.name)
  if (!registration) throw new JsonRpcError(-32602, `Unknown interceptor: ${invocation.name}`)
  if (!interceptorMatches(registration.definition, invocation.event, invocation.phase)) {
    throw new JsonRpcError(-32602, 'Interceptor does not declare this event and phase')
  }
  try {
    return await invokeInterceptor(
      registration,
      invocation,
      await invocationContext(request, 'interceptor/invoke', params, context, options)
    )
  } catch (error) {
    throw interceptorInvocationError(error, registration.definition.name)
  }
}

function assertInterceptorEnabled(options: NormalizedMcpPluginOptions): void {
  if (!options.extensions.interceptors) {
    throw new JsonRpcError(-32601, 'Method not found: interceptor/invoke', undefined, 404)
  }
}

function interceptorInvocation(params: Record<string, unknown>): {
  name: string
  event: string
  phase: 'request' | 'response'
  payload: unknown
  config?: Record<string, unknown>
  timeoutMs?: number
} {
  const nameValid = typeof params.name === 'string'
  const eventValid = typeof params.event === 'string' && params.event.length > 0
  const phaseValid = params.phase === 'request' || params.phase === 'response'
  if (!nameValid || !eventValid || !phaseValid || !Object.hasOwn(params, 'payload')) {
    throw new JsonRpcError(-32602, 'Invalid interceptor invocation')
  }
  if (!validInterceptorConfig(params.config) || !validInterceptorTimeout(params.timeoutMs)) {
    throw new JsonRpcError(-32602, 'Invalid interceptor invocation')
  }
  return {
    name: params.name as string,
    event: params.event as string,
    phase: params.phase as 'request' | 'response',
    payload: params.payload,
    config: params.config as Record<string, unknown> | undefined,
    timeoutMs: params.timeoutMs as number | undefined
  }
}

function validInterceptorConfig(value: unknown): boolean {
  return value === undefined || isRecord(value)
}

function validInterceptorTimeout(value: unknown): boolean {
  return value === undefined || (Number.isSafeInteger(value) && Number(value) > 0)
}

function interceptorInvocationError(error: unknown, name: string): JsonRpcError {
  if (error instanceof McpInterceptorTimeoutError) {
    return new JsonRpcError(-32000, error.message, {
      interceptor: error.interceptor,
      timeoutMs: error.timeoutMs,
      phase: error.phase
    })
  }
  if (error instanceof McpInterceptorExecutionError) {
    return new JsonRpcError(-32603, error.message, {
      interceptor: error.interceptor,
      reason: error.reason
    })
  }
  return new JsonRpcError(-32603, 'Interceptor execution failed', {
    interceptor: name,
    reason: 'Invocation failed'
  })
}

function interceptorCapabilities(app: AnyElysiaApp): { supportedEvents: string[] } {
  const supportedEvents = new Set<string>()
  for (const { definition } of ensureMcpState(app).explicitInterceptors.values())
    for (const hook of definition.hooks) for (const event of hook.events) supportedEvents.add(event)
  return { supportedEvents: [...supportedEvents].sort() }
}

function listTools(
  app: AnyElysiaApp,
  params: Record<string, unknown>,
  request: Request,
  options: NormalizedMcpPluginOptions,
  context: DispatchContext
): Record<string, unknown> {
  const registry = getMcpRegistry(app, options)
  validateAppReferences(registry.tools.values(), registry.resources, options)
  const tools = Array.from(registry.tools.values())
    .filter((tool) => variantAllows(context.activeVariant, 'tools', tool.name))
    .filter((tool) => isAuthorized(tool.authorization, context.authorization))
    .filter((tool) => isToolVisible(tool, context))
    .map((tool) => {
      if (context.protocol.modern) assertValidMirroredHeaderSchema(tool)
      return serializeTool(tool, options)
    })
  return paginate('tools/list', 'tools', tools, params, request, context, options)
}

async function callTool(
  app: AnyElysiaApp,
  params: Record<string, unknown>,
  request: Request,
  options: NormalizedMcpPluginOptions,
  context: DispatchContext
): Promise<unknown> {
  const name = params.name
  if (typeof name !== 'string') throw new JsonRpcError(-32602, 'Missing tool name')
  const tool = getMcpRegistry(app, options).tools.get(name)
  if (!tool || !variantAllows(context.activeVariant, 'tools', name)) {
    throw variantUnknown(`Unknown tool: ${name}`, context)
  }
  if (context.protocol.modern) {
    assertValidMirroredHeaderSchema(tool)
    assertMirroredToolHeaders(request, tool, params.arguments)
  }
  enforceAuthorization(tool.authorization, context.authorization, options)

  const args = 'arguments' in params ? params.arguments : {}
  assertToolInputElementLimit(args, options)
  const invocation = await invocationContext(request, 'tools/call', params, context, options)
  const taskDecision = toolTaskDecision(tool, params, context, options)
  if (!taskDecision) return invokeToolWithinInputLimit(tool, args, invocation, options)
  return createToolTask(tool, args, invocation, params, request, context, options)
}

function toolTaskDecision(
  tool: McpToolDefinition,
  params: Record<string, unknown>,
  context: DispatchContext,
  options: NormalizedMcpPluginOptions
): boolean {
  if (!options.extensions.tasks) {
    if (tool.taskExecution === 'required') {
      throw new JsonRpcError(
        -32021,
        'This tool requires the Tasks extension to be enabled',
        undefined,
        400
      )
    }
    return false
  }
  if (tool.taskExecution === 'synchronous') return false
  const meta = isRecord(params._meta) ? params._meta : undefined
  const supported = context.protocol.modern && hasTasksCapability(meta)
  const capabilityMeta = context.protocol.modern ? meta : undefined
  if (!supported && tool.taskExecution === 'required') {
    taskController(options).assertClientCapability(capabilityMeta)
  }
  return supported
}

function taskExecutionRequest(
  request: Request,
  signal: AbortSignal | undefined
): { request: Request; signal: AbortSignal } {
  const executionSignal = signal ?? request.signal
  if (executionSignal === request.signal) return { request, signal: executionSignal }
  return {
    request: new Request(request.url, {
      method: request.method,
      headers: request.headers,
      signal: executionSignal
    }),
    signal: executionSignal
  }
}

async function createToolTask(
  tool: McpToolDefinition,
  args: unknown,
  invocation: McpInvocationContext,
  params: Record<string, unknown>,
  request: Request,
  context: DispatchContext,
  options: NormalizedMcpPluginOptions
): Promise<unknown> {
  const tasks = options.extensions.tasks
  if (!tasks) throw new JsonRpcError(-32601, 'Tasks extension is not enabled', undefined, 404)
  const controller = taskController(options)
  invocation.task = controller
  setTaskController(request, controller)
  return controller.create(
    {
      mode: tool.taskExecution === 'required' ? 'required' : 'optional',
      ttlMs: tasks.defaultTtl,
      pollIntervalMs: tasks.pollInterval,
      execution: {
        method: 'tools/call',
        params,
        invoke: async (signal) => {
          const execution = taskExecutionRequest(request, signal)
          setTaskController(execution.request, controller)
          return (await invokeToolWithinInputLimit(
            tool,
            args,
            {
              ...invocation,
              request: execution.request,
              signal: execution.signal,
              task: controller
            },
            options
          )) as unknown as Record<string, unknown>
        }
      }
    },
    taskRequestContext(request, params, context)
  )
}

function assertToolInputElementLimit(args: unknown, options: NormalizedMcpPluginOptions): void {
  if (!exceedsInputElementLimit(args, options.core.maxToolInputElements)) return
  throw new JsonRpcError(
    -32602,
    `Tool input exceeds the configured limit of ${options.core.maxToolInputElements} elements`,
    { maxToolInputElements: options.core.maxToolInputElements },
    400
  )
}

function invokeToolWithinInputLimit(
  tool: McpToolDefinition,
  args: unknown,
  invocation: McpInvocationContext,
  options: NormalizedMcpPluginOptions
): Promise<unknown> {
  assertToolInputElementLimit(args, options)
  return tool.invoke(args, invocation)
}

function listResources(
  app: AnyElysiaApp,
  params: Record<string, unknown>,
  request: Request,
  options: NormalizedMcpPluginOptions,
  context: DispatchContext
): Record<string, unknown> {
  const registry = getMcpRegistry(app, options)
  const resources = Array.from(registry.resources.values())
    .filter((resource) => variantAllows(context.activeVariant, 'resources', resource.uri))
    .filter((resource) => isAuthorized(resource.authorization, context.authorization))
    .map((resource) => serializeResource(resource, options))
  return paginate('resources/list', 'resources', resources, params, request, context, options)
}

function listResourceTemplates(
  app: AnyElysiaApp,
  params: Record<string, unknown>,
  request: Request,
  options: NormalizedMcpPluginOptions,
  context: DispatchContext
): Record<string, unknown> {
  const registry = getMcpRegistry(app, options)
  const resourceTemplates = Array.from(registry.resourceTemplates.values())
    .filter((template) => variantAllows(context.activeVariant, 'resources', template.uriTemplate))
    .filter((template) => isAuthorized(template.authorization, context.authorization))
    .map((template) => serializeResourceTemplate(template, options))
  return paginate(
    'resources/templates/list',
    'resourceTemplates',
    resourceTemplates,
    params,
    request,
    context,
    options
  )
}

async function readResource(
  app: AnyElysiaApp,
  params: Record<string, unknown>,
  request: Request,
  options: NormalizedMcpPluginOptions,
  context: DispatchContext
): Promise<unknown> {
  const uri = params.uri
  if (typeof uri !== 'string') throw new JsonRpcError(-32602, 'Missing resource uri')
  if (!variantAllows(context.activeVariant, 'resources', uri)) {
    throw variantUnknown(`Resource not found: ${uri}`, context)
  }
  const skillResult = await readSkillResource(
    app,
    uri,
    params,
    request,
    options,
    context,
    SKILL_REQUEST_RUNTIME
  )
  if (skillResult) return skillResult
  const reader = findResourceReader(getMcpRegistry(app, options), uri)
  if (!reader) {
    throw new JsonRpcError(
      context.protocol.modern ? -32602 : -32002,
      `Resource not found: ${uri}`,
      {
        uri
      }
    )
  }
  enforceAuthorization(reader.definition.authorization, context.authorization, options)
  const result = await reader.definition.read({
    ...(await invocationContext(request, 'resources/read', params, context, options)),
    uri,
    variables: reader.variables
  })

  if (!isInputRequiredResult(result) && options.extensions.apps && uri.startsWith('ui://')) {
    result.contents = result.contents.map((content) => {
      const ui = resolveMcpAppsResourceMeta(
        reader.definition.app ? { ui: reader.definition.app } : undefined,
        content._meta
      )
      const normalized = {
        ...content,
        _meta: ui ? { ...(content._meta ?? {}), ui } : content._meta
      }
      if (normalized._meta) {
        assertMcpAppsResourceMetadata(normalized._meta, options.extensions.apps?.version ?? 'draft')
      }
      assertMcpAppsResourceContent(normalized)
      assertCompleteAppsHtml(normalized)
      return normalized
    })
  }
  return result
}

function listPrompts(
  app: AnyElysiaApp,
  params: Record<string, unknown>,
  request: Request,
  options: NormalizedMcpPluginOptions,
  context: DispatchContext
): Record<string, unknown> {
  const prompts = Array.from(getMcpRegistry(app, options).prompts.values())
    .filter((prompt) => variantAllows(context.activeVariant, 'prompts', prompt.name))
    .filter((prompt) => isAuthorized(prompt.authorization, context.authorization))
    .map(serializePrompt)
  return paginate('prompts/list', 'prompts', prompts, params, request, context, options)
}

async function getPrompt(
  app: AnyElysiaApp,
  params: Record<string, unknown>,
  request: Request,
  options: NormalizedMcpPluginOptions,
  context: DispatchContext
): Promise<unknown> {
  const name = params.name
  if (typeof name !== 'string') throw new JsonRpcError(-32602, 'Missing prompt name')
  const prompt = getMcpRegistry(app, options).prompts.get(name)
  if (!prompt || !variantAllows(context.activeVariant, 'prompts', name)) {
    throw variantUnknown(`Invalid prompt name: ${name}`, context)
  }
  enforceAuthorization(prompt.authorization, context.authorization, options)
  const args = isRecord(params.arguments) ? params.arguments : {}
  return prompt.get(args, {
    ...(await invocationContext(request, 'prompts/get', params, context, options)),
    name
  })
}

async function completeArgument(
  app: AnyElysiaApp,
  params: Record<string, unknown>,
  request: Request,
  options: NormalizedMcpPluginOptions,
  context: DispatchContext
): Promise<Record<string, unknown>> {
  const { ref, argument } = completionInput(params)
  const target = completionTarget(app, ref, options)
  if (!target?.complete) throw new JsonRpcError(-32602, 'Completion target is unavailable')
  assertCompletionVariant(ref, context)
  enforceAuthorization(target.authorization, context.authorization, options)
  const completion = await target.complete(
    {
      ref: ref as any,
      argument: { name: argument.name, value: argument.value },
      context: completionContext(params.context)
    },
    await invocationContext(request, 'completion/complete', params, context, options)
  )
  assertCompletionResult(completion)
  return { completion }
}

function completionInput(params: Record<string, unknown>): {
  ref: Record<string, unknown>
  argument: { name: string; value: string }
} {
  if (!isRecord(params.ref) || !isRecord(params.argument)) {
    throw new JsonRpcError(-32602, 'completion/complete requires ref and argument')
  }
  if (typeof params.argument.name !== 'string' || typeof params.argument.value !== 'string') {
    throw new JsonRpcError(-32602, 'completion argument requires string name and value')
  }
  return {
    ref: params.ref,
    argument: { name: params.argument.name, value: params.argument.value }
  }
}

function completionTarget(
  app: AnyElysiaApp,
  ref: Record<string, unknown>,
  options: NormalizedMcpPluginOptions
): McpPromptDefinition | McpResourceTemplateDefinition | undefined {
  const registry = getMcpRegistry(app, options)
  if (ref.type === 'ref/prompt' && typeof ref.name === 'string') {
    return registry.prompts.get(ref.name)
  }
  if (ref.type === 'ref/resource' && typeof ref.uri === 'string') {
    return registry.resourceTemplates.get(ref.uri)
  }
  return undefined
}

function assertCompletionVariant(ref: Record<string, unknown>, context: DispatchContext): void {
  const promptDenied =
    ref.type === 'ref/prompt' && !variantAllows(context.activeVariant, 'prompts', String(ref.name))
  const resourceDenied =
    ref.type === 'ref/resource' &&
    !variantAllows(context.activeVariant, 'resources', String(ref.uri))
  if (promptDenied || resourceDenied) {
    throw variantUnknown('Completion target is unavailable', context)
  }
}

function completionContext(value: unknown): { arguments?: Record<string, string> } | undefined {
  if (!isRecord(value)) return undefined
  if (!isRecord(value.arguments)) return { arguments: undefined }
  return {
    arguments: Object.fromEntries(
      Object.entries(value.arguments).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string'
      )
    )
  }
}

function assertCompletionResult(completion: {
  values: string[]
  total?: number
  hasMore?: boolean
}): void {
  const valuesInvalid =
    !Array.isArray(completion.values) ||
    completion.values.length > 100 ||
    !completion.values.every((value) => typeof value === 'string')
  const totalInvalid =
    completion.total !== undefined &&
    (!Number.isSafeInteger(completion.total) || completion.total < 0)
  const hasMoreInvalid = completion.hasMore !== undefined && typeof completion.hasMore !== 'boolean'
  if (valuesInvalid || totalInvalid || hasMoreInvalid) {
    throw new JsonRpcError(-32603, 'Completion callback returned an invalid completion result')
  }
}

function paginate(
  method: string,
  field: string,
  values: Record<string, unknown>[],
  params: Record<string, unknown>,
  request: Request,
  context: DispatchContext,
  options: NormalizedMcpPluginOptions
): Record<string, unknown> {
  const supportsPagination = context.protocol.modern || options.extensions.variants !== undefined
  if (!supportsPagination || !options.core.pagination) {
    if (supportsPagination && params.cursor !== undefined) {
      throw new JsonRpcError(-32602, 'Pagination is not configured')
    }
    return { [field]: values }
  }
  const invocation = invocationContextBase(request, params, context)
  const offset = decodeCursor(params.cursor, method, params, invocation, options)
  if (offset > values.length) throw new JsonRpcError(-32602, 'Invalid pagination cursor')
  const end = Math.min(offset + options.core.pagination.pageSize, values.length)
  return {
    [field]: values.slice(offset, end),
    ...(end < values.length
      ? { nextCursor: encodeCursor(method, end, params, invocation, options) }
      : {})
  }
}

function serializeTool(
  tool: McpToolDefinition,
  options: NormalizedMcpPluginOptions
): Record<string, unknown> {
  const metadata =
    options.extensions.apps && tool.app ? normalizeMcpAppsToolMetadata({ ui: tool.app }) : undefined
  if (metadata && options.extensions.apps?.includeDeprecatedResourceUri === false) {
    delete metadata[MCP_APPS_RESOURCE_URI_META_KEY]
  }
  if (metadata && options.extensions.apps) {
    assertMcpAppsToolMetadata(metadata, options.extensions.apps.version)
  }
  return pruneUndefined({
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema,
    annotations: tool.annotations,
    icons: tool.icons,
    _meta: metadata
  })
}

function serializeResource(
  resource: McpResourceDefinition,
  options: NormalizedMcpPluginOptions
): Record<string, unknown> {
  if (resource.app && options.extensions.apps) {
    assertMcpAppsResourceMetadata({ ui: resource.app }, options.extensions.apps.version)
  }
  return pruneUndefined({
    uri: resource.uri,
    name: resource.name,
    title: resource.title,
    description: resource.description,
    mimeType: resource.mimeType,
    annotations: resource.annotations,
    icons: resource.icons,
    _meta: options.extensions.apps && resource.app ? { ui: resource.app } : undefined
  })
}

function serializeResourceTemplate(
  template: McpResourceTemplateDefinition,
  options: NormalizedMcpPluginOptions
): Record<string, unknown> {
  if (template.app && options.extensions.apps) {
    assertMcpAppsResourceMetadata({ ui: template.app }, options.extensions.apps.version)
  }
  return pruneUndefined({
    uriTemplate: template.uriTemplate,
    name: template.name,
    title: template.title,
    description: template.description,
    mimeType: template.mimeType,
    annotations: template.annotations,
    icons: template.icons,
    _meta: options.extensions.apps && template.app ? { ui: template.app } : undefined
  })
}

function serializePrompt(prompt: McpPromptDefinition): Record<string, unknown> {
  return pruneUndefined({
    name: prompt.name,
    title: prompt.title,
    description: prompt.description,
    arguments: prompt.arguments,
    icons: prompt.icons
  })
}

async function authorizeRequest(
  request: Request,
  options: NormalizedMcpPluginOptions
): Promise<McpAuthorizationContext | Response | undefined> {
  const auth = options.extensions.auth
  if (!auth) return undefined
  if (new URL(request.url).searchParams.has('access_token')) {
    return oauthFailure(
      401,
      buildBearerChallenge({
        resourceMetadata: protectedResourceMetadataUrl(auth.resource),
        error: 'invalid_request',
        errorDescription: 'Query-string access tokens are not accepted'
      }),
      'invalid_request'
    )
  }
  const result = await authorizeBearerRequest(request, {
    resource: auth.resource,
    verifier: auth.verifyAccessToken,
    authorizationServers: auth.authorizationServers,
    requiredScopes: auth.scopes,
    clockSkewSeconds: auth.clockSkewSeconds
  })
  return result.ok
    ? result.authorization
    : oauthFailure(result.status, result.challenge, result.error, result.missingScopes)
}

function enforceAuthorization(
  requirement: McpAuthorizationOptions | undefined,
  authorization: McpAuthorizationContext | undefined,
  options: NormalizedMcpPluginOptions
): void {
  const required = requirement?.requiredScopes ?? []
  if (required.length === 0) return
  if (!authorization || !options.extensions.auth) {
    throw new JsonRpcError(-32001, 'Authorization required', undefined, 403)
  }
  const missing = missingRequiredScopes(required, authorization.scopes)
  if (missing.length > 0) {
    throw new AuthorizationScopeError(required, missing, options)
  }
}

function isAuthorized(
  requirement: McpAuthorizationOptions | undefined,
  authorization: McpAuthorizationContext | undefined
): boolean {
  return (
    !requirement?.requiredScopes?.length ||
    (!!authorization &&
      missingRequiredScopes(requirement.requiredScopes, authorization.scopes).length === 0)
  )
}

async function invocationContext(
  request: Request,
  method: string,
  params: Record<string, unknown>,
  context: DispatchContext,
  options: NormalizedMcpPluginOptions
): Promise<McpInvocationContext> {
  return {
    request,
    signal: context.signal ?? request.signal,
    meta: isRecord(params._meta) ? params._meta : undefined,
    protocolVersion: context.protocol.version,
    clientCapabilities: context.protocol.clientCapabilities,
    clientInfo: context.protocol.clientInfo,
    inputResponses: parseInputResponses(params),
    requestState: await resolveRequestState(
      request,
      params.requestState,
      method,
      params,
      context.authorization,
      options
    ),
    reportProgress: context.reportProgress,
    authorization: context.authorization
  }
}

function taskController(options: NormalizedMcpPluginOptions): TaskController {
  const tasks = options.extensions.tasks
  if (!tasks) throw new JsonRpcError(-32601, 'Tasks extension is not enabled', undefined, 404)
  return new TaskController({ provider: tasks.provider, version: tasks.version })
}

function extensionDispatcher(
  options: NormalizedMcpPluginOptions,
  context: DispatchContext
): McpExtensionDispatcher {
  const dispatcher = new McpExtensionDispatcher()
  if (options.extensions.tasks) {
    dispatcher.register(['tasks/get', 'tasks/update', 'tasks/cancel'], ({ request, params }) => {
      assertModernTasks(context, options)
      return dispatchTaskRequest(taskController(options), {
        method: paramsMethod(request, params),
        params,
        context: taskRequestContext(request, params, context)
      })
    })
  }
  return dispatcher
}

function paramsMethod(
  request: Request,
  _params: Record<string, unknown>
): 'tasks/get' | 'tasks/update' | 'tasks/cancel' {
  const method = request.headers.get('mcp-method')
  if (method === 'tasks/get' || method === 'tasks/update' || method === 'tasks/cancel')
    return method
  throw new JsonRpcError(-32601, `Method not found: ${method}`, undefined, 404)
}

function taskRequestContext(
  request: Request,
  params: Record<string, unknown>,
  context: DispatchContext
) {
  const principal = context.authorization?.principal
  return {
    request,
    signal: context.signal ?? request.signal,
    meta: isRecord(params._meta) ? params._meta : undefined,
    principalKey: principal
      ? JSON.stringify([
          principal.issuer ?? null,
          principal.subject ?? null,
          principal.clientId ?? null
        ])
      : undefined
  }
}

function assertModernTasks(context: DispatchContext, options: NormalizedMcpPluginOptions): void {
  if (!context.protocol.modern) {
    throw new JsonRpcError(-32601, 'Tasks require MCP 2026-07-28', undefined, 404)
  }
  if (!options.extensions.tasks) {
    throw new JsonRpcError(-32601, 'Tasks extension is not enabled', undefined, 404)
  }
}

function isProgressRequest(payload: unknown): boolean {
  if (!isRecord(payload) || !isRecord(payload.params) || !isRecord(payload.params._meta))
    return false
  if (
    payload.params._meta['io.modelcontextprotocol/protocolVersion'] !==
    MCP_EXTENSION_SUPPORT.protocol.current
  ) {
    return false
  }
  const token = payload.params._meta.progressToken
  return typeof token === 'string' || (typeof token === 'number' && Number.isSafeInteger(token))
}

function handleProgressRequest(
  app: AnyElysiaApp,
  payload: JsonRpcRequest,
  request: Request,
  options: NormalizedMcpPluginOptions,
  authorization?: McpAuthorizationContext
): Response {
  const meta = isRecord(payload.params?._meta) ? payload.params?._meta : {}
  const progressToken = meta.progressToken as string | number
  const encoder = new TextEncoder()
  const abort = new AbortController()
  const unlinkIncomingAbort = linkAbortSignal(request.signal, abort)
  let closed = false
  let lastProgress = Number.NEGATIVE_INFINITY
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (message: unknown) => {
        if (!closed)
          controller.enqueue(encoder.encode(`event: message\ndata: ${JSON.stringify(message)}\n\n`))
      }
      const reportProgress: NonNullable<McpInvocationContext['reportProgress']> = (
        progress,
        detail = {}
      ) => {
        if (!Number.isFinite(progress) || progress <= lastProgress) {
          throw new TypeError('Progress values must be finite and strictly increasing')
        }
        if (detail.total !== undefined && !Number.isFinite(detail.total)) {
          throw new TypeError('Progress total must be finite')
        }
        lastProgress = progress
        send({
          jsonrpc: JSON_RPC_VERSION,
          method: 'notifications/progress',
          params: pruneUndefined({
            progressToken,
            progress,
            total: detail.total,
            message: detail.message
          })
        })
      }
      void handleJsonRpcMessage(app, payload, request, options, authorization, {
        signal: abort.signal,
        reportProgress
      })
        .then((outcome) => {
          if (closed) return
          if (outcome.response) send(outcome.response)
          closed = true
          unlinkIncomingAbort()
          controller.close()
        })
        .catch((error) => {
          if (closed) return
          send(normalizeDispatchError(errorIdForRequest(request, options, payload), error))
          closed = true
          unlinkIncomingAbort()
          controller.close()
        })
    },
    cancel() {
      closed = true
      abort.abort('MCP response stream closed')
      unlinkIncomingAbort()
    }
  })
  return sseResponse(body)
}

function validateAppReferences(
  tools: Iterable<McpToolDefinition>,
  resources: Map<string, McpResourceDefinition>,
  options: NormalizedMcpPluginOptions
): void {
  if (!options.extensions.apps) return
  for (const tool of tools) {
    if (!tool.app?.resourceUri) continue
    assertMcpAppsResourceUri(tool.app.resourceUri)
    const resource = resources.get(tool.app.resourceUri)
    if (!resource) throw new TypeError(`MCP App resource does not exist: ${tool.app.resourceUri}`)
    if (resource.mimeType !== MCP_APPS_RESOURCE_MIME_TYPE) {
      throw new TypeError(
        `MCP App resource ${tool.app.resourceUri} must use ${MCP_APPS_RESOURCE_MIME_TYPE}`
      )
    }
  }
}

function assertCompleteAppsHtml(content: { text?: string; blob?: string }): void {
  const html = content.text ?? decodeAppsBlob(content.blob)
  const complete =
    typeof html === 'string' &&
    [/^\s*<!doctype html>/iu, /<html(?:\s|>)/iu, /<\/html>\s*$/iu].every((pattern) =>
      pattern.test(html)
    )
  if (!complete) {
    throw new TypeError('MCP App resources must contain a complete HTML5 document')
  }
}

function decodeAppsBlob(blob: string | undefined): string | undefined {
  if (blob === undefined) return undefined
  const valid =
    blob.length % 4 === 0 &&
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(blob)
  if (!valid) throw new TypeError('MCP App blob content must be valid base64 HTML')
  return Buffer.from(blob, 'base64').toString('utf8')
}

function isToolVisible(tool: McpToolDefinition, context: DispatchContext): boolean {
  const visibility = tool.app?.visibility ?? ['model', 'app']
  if (visibility.includes('model')) return true
  if (!context.protocol.modern) return true
  const extensions = context.protocol.clientCapabilities.extensions
  if (!isRecord(extensions)) return false
  const apps = extensions[MCP_APPS_EXTENSION_ID]
  if (!isRecord(apps)) return false
  const mimeTypes = apps.mimeTypes
  return Array.isArray(mimeTypes) && mimeTypes.includes(MCP_APPS_RESOURCE_MIME_TYPE)
}

function normalizeDispatchError(
  id: string | number | null | undefined,
  error: unknown
): JsonRpcResponse {
  if (
    error instanceof JsonRpcError ||
    error instanceof McpProtocolError ||
    error instanceof TaskProtocolError ||
    error instanceof McpEventProtocolError
  ) {
    return createErrorResponse(id, error.code, error.message, error.data)
  }
  if (error instanceof AuthorizationScopeError) {
    return createErrorResponse(id, -32001, 'Insufficient scope', {
      requiredScopes: error.required,
      missingScopes: error.missing,
      resource_metadata: error.resourceMetadata
    })
  }
  return createErrorResponse(id, -32603, error instanceof Error ? error.message : 'Internal error')
}

function errorStatus(error: unknown): number {
  if (
    error instanceof JsonRpcError ||
    error instanceof McpProtocolError ||
    error instanceof McpEventProtocolError
  )
    return error.status
  if (error instanceof TaskProtocolError && (error.code === -32021 || error.code === -32003)) {
    return 400
  }
  if (error instanceof AuthorizationScopeError) return 403
  return 200
}

function oauthFailure(
  status: 401 | 403,
  challenge: string,
  error: string,
  missingScopes?: string[]
): Response {
  return new Response(JSON.stringify(pruneUndefined({ error, missing_scopes: missingScopes })), {
    status,
    headers: {
      'content-type': 'application/json',
      'www-authenticate': challenge
    }
  })
}

function variantUnknown(message: string, context: DispatchContext): JsonRpcError {
  return new JsonRpcError(
    -32602,
    message,
    context.activeVariant
      ? {
          activeVariant: context.activeVariant.id,
          hint: 'This identifier may be available in another variant'
        }
      : undefined
  )
}

function validateOrigin(
  request: Request,
  options: NormalizedMcpPluginOptions
): Response | undefined {
  if (!options.transport.validateOrigin) return undefined
  const origin = request.headers.get('origin')
  if (!origin) return undefined
  if (
    options.transport.allowedOrigins.length === 0 ||
    !isOriginAllowed(origin, options.transport.allowedOrigins)
  ) {
    return jsonResponse(
      createErrorResponse(errorIdForRequest(request, options), -32000, 'Forbidden origin'),
      403
    )
  }
  return undefined
}

function jsonResponse(body: unknown, status = 200, extraHeaders: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...extraHeaders }
  })
}

function createErrorResponse(
  id: string | number | null | undefined,
  code: number,
  message: string,
  data?: unknown
): JsonRpcResponse {
  return {
    jsonrpc: JSON_RPC_VERSION,
    ...(id === undefined ? {} : { id }),
    error: pruneUndefined({ code, message, data }) as JsonRpcResponse['error']
  }
}

function errorIdForRequest(
  request: Request,
  options: NormalizedMcpPluginOptions,
  payload?: unknown
): string | number | null | undefined {
  if (isRecord(payload) && isRequestId(payload.id)) return payload.id
  return usesModernErrorEnvelope(request, options) ? undefined : null
}

function usesModernErrorEnvelope(request: Request, options: NormalizedMcpPluginOptions): boolean {
  const protocolHeader = request.headers.get('mcp-protocol-version')
  return (
    protocolHeader === MCP_EXTENSION_SUPPORT.protocol.current ||
    (protocolHeader === null &&
      options.transport.protocolVersions[0] === MCP_EXTENSION_SUPPORT.protocol.current)
  )
}

function isJsonRpcRequest(value: unknown): value is JsonRpcRequest {
  return (
    isRecord(value) &&
    value.jsonrpc === JSON_RPC_VERSION &&
    typeof value.method === 'string' &&
    value.method.length > 0 &&
    (value.id === undefined ||
      value.id === null ||
      typeof value.id === 'string' ||
      typeof value.id === 'number')
  )
}

function pruneUndefined<T extends Record<string, unknown>>(value: T): T {
  const result: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) result[key] = item
  }
  return result as T
}

class JsonRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
    readonly status = 200
  ) {
    super(message)
  }
}

class AuthorizationScopeError extends Error {
  readonly resourceMetadata: string
  constructor(
    readonly required: readonly string[],
    readonly missing: readonly string[],
    options: NormalizedMcpPluginOptions
  ) {
    super('Insufficient scope')
    this.resourceMetadata = protectedResourceMetadataUrl(
      options.extensions.auth?.resource ?? 'https://localhost/mcp'
    ).href
  }
}

import { Buffer } from 'node:buffer'
