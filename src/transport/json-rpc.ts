import { randomUUID } from 'node:crypto'
import { LEGACY_PROTOCOL_VERSION } from '../constants.js'
import { assertTrustResultMetadata } from '../extensions/annotations/index.js'
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
  authProfileCapabilities,
  buildBearerChallenge,
  type McpAuthorizationContext,
  missingRequiredScopes,
  protectedResourceMetadataUrl
} from '../extensions/auth/index.js'
import { McpExtensionDispatcher } from '../extensions/dispatcher.js'
import {
  attachEventSessionStream,
  deleteEventSession,
  initializeEventSession,
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
  MCP_INTERCEPTORS_ID,
  McpInterceptorExecutionError,
  McpInterceptorTimeoutError
} from '../extensions/interceptors/index.js'
import { MCP_EXTENSION_SUPPORT } from '../extensions/manifest.js'
import {
  assertCompatibleSkillDefinitions,
  assertSafeDirectoryUri,
  assertSafeResourceUri,
  createProviderSkillDefinition,
  findSkillDirectoryOwner,
  findStaticDynamicSkill,
  findStaticSkillResource,
  isWithinSkill,
  listStaticSkillDirectory,
  MCP_SKILLS_EXTENSION_ID,
  type McpSkillDefinition,
  type McpSkillDirectoryEntry,
  type McpSkillDynamicDirectoryReader,
  serializeDynamicSkillResource,
  serializeSkillResource
} from '../extensions/skills/index.js'
import {
  type DetailedTask,
  dispatchTaskRequest,
  hasTasksCapability,
  setTaskController,
  TaskController,
  TaskProtocolError,
  type TaskSubscription
} from '../extensions/tasks/index.js'
import {
  MCP_SERVER_VARIANT_META_KEY,
  MCP_SERVER_VARIANTS_ID,
  type McpServerVariant,
  type McpVariantHints
} from '../extensions/variants/index.js'
import { isRecord } from '../internal.js'
import { findResourceReader, getMcpRegistry } from '../registry.js'
import { ensureMcpState, type McpRegistryChangeKind, onRegistryChange } from '../state.js'
import type {
  AnyElysiaApp,
  JsonRpcRequest,
  JsonRpcResponse,
  McpAuthorizationOptions,
  McpInvocationContext,
  McpPromptDefinition,
  McpResourceDefinition,
  McpResourceTemplateDefinition,
  McpServerNotification,
  McpToolDefinition,
  NormalizedMcpPluginOptions
} from '../types.js'
import {
  cachePolicy,
  decodeCursor,
  encodeCursor,
  isInputRequiredResult,
  modernResultMeta,
  parseInputResponses,
  prepareInputRequiredResult,
  resolveRequestState
} from './core.js'
import { assertMirroredToolHeaders, assertValidMirroredHeaderSchema } from './mirrored-headers.js'
import {
  McpProtocolError,
  type McpRequestProtocolContext,
  resolveRequestProtocol,
  serverDiscoverResult
} from './protocol.js'

const JSON_RPC_VERSION = '2.0' as const
const INITIALIZED_SESSION_IDS = new WeakMap<Request, string>()
const VARIANT_SESSIONS = new WeakMap<
  AnyElysiaApp,
  WeakMap<NormalizedMcpPluginOptions, Map<string, VariantSession>>
>()

interface VariantSession {
  principal?: string
  variants: McpServerVariant[]
  streams: Map<ReadableStreamDefaultController<Uint8Array>, ReturnType<typeof setInterval>>
  subscriptions: Map<string, { uri: string; variantId: string; close?: () => Promise<void> }>
}

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

export async function handleMcpHttpRequest(
  app: AnyElysiaApp,
  request: Request,
  options: NormalizedMcpPluginOptions
): Promise<Response> {
  const originValidation = validateOrigin(request, options)
  if (originValidation) return originValidation

  const protocolHeader = request.headers.get('mcp-protocol-version')
  if (
    protocolHeader !== null &&
    !options.transport.protocolVersions.includes(
      protocolHeader as (typeof options.transport.protocolVersions)[number]
    )
  ) {
    return jsonResponse(
      {
        jsonrpc: JSON_RPC_VERSION,
        error: {
          code: -32022,
          message: `Unsupported protocol version: ${protocolHeader}`,
          data: {
            supported: options.transport.protocolVersions,
            requested: protocolHeader
          }
        }
      },
      400
    )
  }

  const authorization = await authorizeRequest(request, options)
  if (authorization instanceof Response) return authorization

  if (request.method === 'GET' || request.method === 'DELETE') {
    if (usesModernErrorEnvelope(request, options)) {
      return jsonResponse(createErrorResponse(undefined, -32600, 'Modern MCP is POST-only'), 405)
    }
    return handleLegacyAuxiliaryMethod(app, request, options, authorization)
  }

  if (request.method !== 'POST') {
    return new Response(null, { status: 405, headers: { allow: 'POST, GET, DELETE' } })
  }

  let payload: unknown
  try {
    payload = await request.json()
  } catch (error) {
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

  if (Array.isArray(payload)) {
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
    if (responses.length === 0) return new Response(null, { status: 202 })
    return jsonResponse(responses)
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
    const eventRequest = payload as unknown as JsonRpcRequest
    if (!options.extensions.events)
      return jsonResponse(
        createErrorResponse(eventRequest.id, -32601, 'Events extension is not enabled'),
        404
      )
    if (!isRequestId(eventRequest.id))
      return jsonResponse(createErrorResponse(undefined, -32600, 'Invalid Request'), 400)
    try {
      const protocol = resolveRequestProtocol(request, eventRequest, options)
      if (protocol.modern)
        throw new McpEventProtocolError(-32601, 'Events extension is legacy-only', undefined, 404)
      const params = isRecord(eventRequest.params) ? eventRequest.params : {}
      const dispatch: DispatchContext = { protocol, authorization }
      if (options.extensions.variants) {
        const selected = await resolveActiveVariant(app, request, params, options, authorization)
        dispatch.activeVariant = selected.variant
        dispatch.sessionId = selected.sessionId
        const meta = isRecord(params._meta) ? { ...params._meta } : {}
        meta[MCP_SERVER_VARIANT_META_KEY] = selected.variant.id
        params._meta = meta
      }
      return await streamEvents(
        app,
        params,
        eventRequest.id,
        options,
        await invocationContext(request, 'events/stream', params, dispatch, options)
      )
    } catch (error) {
      return jsonResponse(normalizeDispatchError(eventRequest.id, error), errorStatus(error))
    }
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
  if (!outcome.response) return new Response(null, { status: 202 })
  const initializedSessionId = INITIALIZED_SESSION_IDS.get(request)
  const responseHeaders: HeadersInit = {
    ...(initializedSessionId ? { 'mcp-session-id': initializedSessionId } : {}),
    ...(outcome.status === 403 && options.extensions.auth
      ? {
          'www-authenticate': buildBearerChallenge({
            resourceMetadata: protectedResourceMetadataUrl(options.extensions.auth.resource),
            error: 'insufficient_scope',
            scope:
              outcome.response?.error &&
              isRecord(outcome.response.error.data) &&
              Array.isArray(outcome.response.error.data.requiredScopes)
                ? outcome.response.error.data.requiredScopes.filter(
                    (scope): scope is string => typeof scope === 'string'
                  )
                : undefined
          })
        }
      : {})
  }
  return jsonResponse(outcome.response, outcome.status, responseHeaders)
}

async function handleJsonRpcMessage(
  app: AnyElysiaApp,
  payload: unknown,
  request: Request,
  options: NormalizedMcpPluginOptions,
  authorization?: McpAuthorizationContext,
  overrides: Pick<DispatchContext, 'signal' | 'reportProgress'> = {}
): Promise<RpcOutcome> {
  if (!isJsonRpcRequest(payload)) {
    return {
      response: createErrorResponse(
        errorIdForRequest(request, options, payload),
        -32600,
        'Invalid Request'
      ),
      status: 400
    }
  }

  const id = payload.id ?? null
  const errorId = errorIdForRequest(request, options, payload)
  if (
    usesModernErrorEnvelope(request, options) &&
    payload.id !== undefined &&
    !isRequestId(payload.id)
  ) {
    return {
      response: createErrorResponse(undefined, -32600, 'Invalid Request'),
      status: 400
    }
  }

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
          options
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
  const method = payload.method
  const params = isRecord(payload.params) ? payload.params : {}

  if (options.extensions.variants && method !== 'initialize') {
    const selected = await resolveActiveVariant(
      app,
      request,
      params,
      options,
      context.authorization
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

  const extensionResult = await extensionDispatcher(options, context).dispatch(method, {
    request,
    params
  })
  if (extensionResult.handled) return extensionResult.result

  switch (method) {
    case 'initialize':
      if (context.protocol.modern)
        throw new JsonRpcError(-32601, 'Method not found: initialize', undefined, 404)
      return initializeResult(app, request, params, options, context.authorization)
    case 'server/discover':
      if (!context.protocol.modern) {
        throw new JsonRpcError(-32601, 'Method not found: server/discover', undefined, 404)
      }
      return modernDiscoverResult(app, options)
    case 'ping':
      if (context.protocol.modern) {
        throw new JsonRpcError(-32601, 'Method not found: ping', undefined, 404)
      }
      return {}
    case 'tools/list':
      return listTools(app, params, request, options, context)
    case 'tools/call':
      return callTool(app, params, request, options, context)
    case 'resources/list':
      return listResources(app, params, request, options, context)
    case 'resources/templates/list':
      return listResourceTemplates(app, params, request, options, context)
    case 'resources/read':
      return readResource(app, params, request, options, context)
    case 'resources/subscribe':
      return subscribeVariantResource(app, params, request, options, context)
    case 'resources/unsubscribe':
      return unsubscribeVariantResource(app, params, options, context)
    case 'skills/list':
      return listSkills(app, params, request, options, context)
    case 'skills/get':
      return getSkill(app, params, request, options, context)
    case 'resources/directory/read':
      return readSkillDirectory(app, params, request, options, context)
    case 'interceptors/list':
      return listInterceptors(app, params, options)
    case 'interceptor/invoke':
      return invokeRegisteredInterceptor(app, params, request, options, context)
    case 'events/list':
      return listEvents(
        app,
        params,
        request,
        options,
        await invocationContext(request, method, params, context, options)
      )
    case 'events/poll':
      return pollEvents(
        app,
        params,
        options,
        await invocationContext(request, method, params, context, options)
      )
    case 'events/subscribe':
      return subscribeEventsWebhook(
        app,
        params,
        options,
        await invocationContext(request, method, params, context, options)
      )
    case 'events/unsubscribe':
      return unsubscribeEventsWebhook(
        app,
        params,
        options,
        await invocationContext(request, method, params, context, options)
      )
    case 'prompts/list':
      return listPrompts(app, params, request, options, context)
    case 'prompts/get':
      return getPrompt(app, params, request, options, context)
    case 'completion/complete':
      if (!context.protocol.modern && !options.extensions.variants)
        throw new JsonRpcError(-32601, 'Method not found: completion/complete', undefined, 404)
      return completeArgument(app, params, request, options, context)
    default:
      throw new JsonRpcError(
        -32601,
        `Method not found: ${method}`,
        undefined,
        context.protocol.modern ? 404 : 200
      )
  }
}

async function initializeResult(
  app: AnyElysiaApp,
  request: Request,
  params: Record<string, unknown>,
  options: NormalizedMcpPluginOptions,
  authorization?: McpAuthorizationContext
): Promise<Record<string, unknown>> {
  const extensions: Record<string, unknown> = {}
  let initializedVariant: string | undefined
  if (options.extensions.apps) {
    extensions[MCP_APPS_EXTENSION_ID] = { mimeTypes: [MCP_APPS_RESOURCE_MIME_TYPE] }
  }
  if (options.extensions.interceptors)
    extensions[MCP_INTERCEPTORS_ID] = interceptorCapabilities(app)
  if (options.extensions.variants) {
    const context = invocationContextBase(request, params, {
      protocol: {
        modern: false,
        version: LEGACY_PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: undefined,
        meta: undefined
      },
      authorization
    })
    const hints = variantHints(params)
    const visible = [] as McpServerVariant[]
    for (const variant of options.extensions.variants.variants) {
      if ((await options.extensions.variants.visible?.(variant, context)) ?? true)
        visible.push(variant)
    }
    const ranked = await rankVariants(visible, hints, context, options)
    const requestsExperimental = Object.values(hints?.hints ?? {})
      .flat()
      .includes('experimental')
    if (!requestsExperimental && (ranked[0]?.status ?? 'stable') !== 'stable') {
      const stableIndex = ranked.findIndex(({ status }) => (status ?? 'stable') === 'stable')
      if (stableIndex < 0) throw new JsonRpcError(-32603, 'No stable server variant is visible')
      const stable = ranked.splice(stableIndex, 1)[0] as McpServerVariant
      ranked.unshift(stable)
    }
    const limit =
      ranked.length > 1
        ? Math.max(2, options.extensions.variants.discoveryLimit)
        : options.extensions.variants.discoveryLimit
    const available = ranked.slice(0, limit)
    if (available.length === 0) throw new JsonRpcError(-32603, 'No server variants are visible')
    const sessionId = randomUUID()
    variantSessions(app, options).set(sessionId, {
      principal: variantPrincipal(authorization),
      variants: available.map((variant) => structuredClone(variant)),
      streams: new Map(),
      subscriptions: new Map()
    })
    INITIALIZED_SESSION_IDS.set(request, sessionId)
    initializedVariant = available[0]?.id
    extensions[MCP_SERVER_VARIANTS_ID] = {
      availableVariants: available.map(publicVariant),
      moreVariantsAvailable: ranked.length > available.length
    }
  }
  if (options.extensions.events) {
    const sessionId = initializeEventSession(
      app,
      variantPrincipal(authorization),
      initializedVariant,
      INITIALIZED_SESSION_IDS.get(request),
      options
    )
    INITIALIZED_SESSION_IDS.set(request, sessionId)
  }

  return {
    protocolVersion: options.transport.protocolVersion,
    capabilities: {
      tools: { listChanged: false },
      resources: {
        subscribe: options.core.subscriptions?.resources ?? false,
        listChanged: options.core.subscriptions?.resourcesListChanged ?? false
      },
      prompts: { listChanged: false },
      ...(options.extensions.events
        ? { events: { listChanged: options.transport.enableGetSse } }
        : {}),
      ...(Object.keys(extensions).length > 0 ? { extensions } : {})
    },
    serverInfo: {
      name: options.server.name,
      version: options.server.version,
      title: options.server.title
    },
    instructions: options.server.instructions
  }
}

function modernDiscoverResult(
  app: AnyElysiaApp,
  options: NormalizedMcpPluginOptions
): Record<string, unknown> {
  const result = serverDiscoverResult(options)
  const registry = getMcpRegistry(app, options)
  const extensions: Record<string, unknown> = {}
  if (options.extensions.tasks) {
    extensions['io.modelcontextprotocol/tasks'] = {}
  }
  if (options.extensions.apps) {
    extensions[MCP_APPS_EXTENSION_ID] = { mimeTypes: [MCP_APPS_RESOURCE_MIME_TYPE] }
  }
  if (options.extensions.auth) {
    Object.assign(extensions, authProfileCapabilities(options.extensions.auth.profiles))
  }
  if (options.extensions.interceptors)
    extensions[MCP_INTERCEPTORS_ID] = interceptorCapabilities(app)
  const skillsEnabled =
    registry.skills.size > 0 || options.extensions.skills?.provider !== undefined
  if (skillsEnabled) {
    extensions[MCP_SKILLS_EXTENSION_ID] = {
      directoryRead: options.extensions.skills?.directoryRead ?? false
    }
  }
  return {
    ...result,
    capabilities: {
      ...(registry.tools.size > 0
        ? { tools: { listChanged: options.core.subscriptions?.toolsListChanged ?? false } }
        : {}),
      ...(registry.resources.size > 0 || registry.resourceTemplates.size > 0 || skillsEnabled
        ? {
            resources: {
              subscribe: options.core.subscriptions?.resources ?? false,
              listChanged: options.core.subscriptions?.resourcesListChanged ?? false
            }
          }
        : {}),
      ...(registry.prompts.size > 0
        ? { prompts: { listChanged: options.core.subscriptions?.promptsListChanged ?? false } }
        : {}),
      ...(hasCompletion(registry) ? { completions: {} } : {}),
      ...(Object.keys(extensions).length > 0 ? { extensions } : {})
    }
  }
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
  if (!options.extensions.interceptors) {
    throw new JsonRpcError(-32601, 'Method not found: interceptor/invoke', undefined, 404)
  }
  if (
    typeof params.name !== 'string' ||
    typeof params.event !== 'string' ||
    params.event.length === 0 ||
    (params.phase !== 'request' && params.phase !== 'response') ||
    !Object.hasOwn(params, 'payload') ||
    (params.config !== undefined && !isRecord(params.config)) ||
    (params.timeoutMs !== undefined &&
      (!Number.isSafeInteger(params.timeoutMs) || Number(params.timeoutMs) <= 0))
  ) {
    throw new JsonRpcError(-32602, 'Invalid interceptor invocation')
  }
  const registration = ensureMcpState(app).explicitInterceptors.get(params.name)
  if (!registration) throw new JsonRpcError(-32602, `Unknown interceptor: ${params.name}`)
  if (!interceptorMatches(registration.definition, params.event, params.phase)) {
    throw new JsonRpcError(-32602, 'Interceptor does not declare this event and phase')
  }
  try {
    return await invokeInterceptor(
      registration,
      {
        name: params.name,
        event: params.event,
        phase: params.phase,
        payload: params.payload,
        config: params.config as Record<string, unknown> | undefined,
        timeoutMs: params.timeoutMs as number | undefined
      },
      await invocationContext(request, 'interceptor/invoke', params, context, options)
    )
  } catch (error) {
    if (error instanceof McpInterceptorTimeoutError) {
      throw new JsonRpcError(-32000, error.message, {
        interceptor: error.interceptor,
        timeoutMs: error.timeoutMs,
        phase: error.phase
      })
    }
    if (error instanceof McpInterceptorExecutionError) {
      throw new JsonRpcError(-32603, error.message, {
        interceptor: error.interceptor,
        reason: error.reason
      })
    }
    throw new JsonRpcError(-32603, 'Interceptor execution failed', {
      interceptor: registration.definition.name,
      reason: 'Invocation failed'
    })
  }
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
  const invocation = await invocationContext(request, 'tools/call', params, context, options)
  const tasks = options.extensions.tasks
  if (!tasks) {
    if (tool.taskExecution === 'required') {
      throw new JsonRpcError(
        -32021,
        'This tool requires the Tasks extension to be enabled',
        undefined,
        400
      )
    }
    return tool.invoke(args, invocation)
  }
  if (tool.taskExecution === 'synchronous') return tool.invoke(args, invocation)

  if (!context.protocol.modern) {
    if (tool.taskExecution === 'required') {
      taskController(options).assertClientCapability(undefined)
    }
    return tool.invoke(args, invocation)
  }

  const supportsTasks = hasTasksCapability(isRecord(params._meta) ? params._meta : undefined)
  if (!supportsTasks) {
    if (tool.taskExecution === 'required') {
      taskController(options).assertClientCapability(
        isRecord(params._meta) ? params._meta : undefined
      )
    }
    return tool.invoke(args, invocation)
  }

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
          const executionSignal = signal ?? request.signal
          const executionRequest =
            executionSignal === request.signal
              ? request
              : new Request(request.url, {
                  method: request.method,
                  headers: request.headers,
                  signal: executionSignal
                })
          setTaskController(executionRequest, controller)
          return (await tool.invoke(args, {
            ...invocation,
            request: executionRequest,
            signal: executionSignal,
            task: controller
          })) as unknown as Record<string, unknown>
        }
      }
    },
    taskRequestContext(request, params, context)
  )
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
  const skillResult = await readSkillResource(app, uri, params, request, options, context)
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

async function subscribeVariantResource(
  app: AnyElysiaApp,
  params: Record<string, unknown>,
  request: Request,
  options: NormalizedMcpPluginOptions,
  context: DispatchContext
): Promise<Record<string, unknown>> {
  if (!options.extensions.variants || !context.activeVariant || !context.sessionId) {
    throw new JsonRpcError(-32601, 'Method not found: resources/subscribe')
  }
  if (!options.core.subscriptions?.resources) {
    throw new JsonRpcError(-32601, 'Resource subscriptions are not configured')
  }
  const uri = params.uri
  if (typeof uri !== 'string' || !variantAllows(context.activeVariant, 'resources', uri)) {
    throw new JsonRpcError(-32602, 'Resource is unavailable in the active variant', {
      activeVariant: context.activeVariant.id
    })
  }
  const reader = findResourceReader(getMcpRegistry(app, options), uri)
  if (!reader) {
    throw new JsonRpcError(-32602, 'Resource is unavailable in the active variant', {
      activeVariant: context.activeVariant.id
    })
  }
  enforceAuthorization(reader.definition.authorization, context.authorization, options)
  const session = variantSessions(app, options).get(context.sessionId)
  if (!session) throw new JsonRpcError(-32602, 'Unknown MCP session')
  const subscriptionId = randomUUID()
  const subscription = { uri, variantId: context.activeVariant.id } as {
    uri: string
    variantId: string
    close?: () => Promise<void>
  }
  const provider = options.core.subscriptions.provider
  const subscriptionAbort = new AbortController()
  const unlinkRequestAbort = linkAbortSignal(request.signal, subscriptionAbort)
  let iterable: AsyncIterable<McpServerNotification>
  try {
    iterable = await provider.subscribe(
      { resourceSubscriptions: [uri] },
      await invocationContext(
        request,
        'resources/subscribe',
        params,
        { ...context, signal: subscriptionAbort.signal },
        options
      )
    )
  } catch (error) {
    unlinkRequestAbort()
    subscriptionAbort.abort('Resource subscription setup failed')
    throw error
  }
  const iterator = iterable[Symbol.asyncIterator]()
  let closed = false
  subscription.close = async () => {
    if (closed) return
    closed = true
    subscriptionAbort.abort('Resource subscription closed')
    unlinkRequestAbort()
    void safelyReturnIterator(iterator)
  }
  session.subscriptions.set(subscriptionId, subscription)
  void (async () => {
    try {
      while (!closed) {
        const next = await iterator.next()
        if (next.done || !session.subscriptions.has(subscriptionId)) break
        if (
          next.value.method !== 'notifications/resources/updated' ||
          next.value.params.uri !== uri
        )
          continue
        const currentAuthorization = await authorizeRequest(request, options)
        const currentVariant = options.extensions.variants?.variants.find(
          ({ id }) => id === subscription.variantId
        )
        const currentReader = currentVariant
          ? findResourceReader(getMcpRegistry(app, options), uri)
          : undefined
        if (
          currentAuthorization instanceof Response ||
          variantPrincipal(currentAuthorization) !== session.principal ||
          !currentVariant ||
          !variantAllows(currentVariant, 'resources', uri) ||
          !currentReader ||
          !isAuthorized(currentReader.definition.authorization, currentAuthorization)
        ) {
          emitVariantNotification(session, {
            method: 'notifications/resources/list_changed',
            params: { _meta: { [MCP_SERVER_VARIANT_META_KEY]: subscription.variantId } }
          })
          break
        }
        emitVariantNotification(session, {
          ...next.value,
          params: {
            ...next.value.params,
            _meta: { [MCP_SERVER_VARIANT_META_KEY]: subscription.variantId }
          }
        })
      }
    } catch {
      emitVariantNotification(session, {
        method: 'notifications/resources/list_changed',
        params: { _meta: { [MCP_SERVER_VARIANT_META_KEY]: subscription.variantId } }
      })
    } finally {
      if (!closed) {
        closed = true
        subscriptionAbort.abort('Resource subscription ended')
        unlinkRequestAbort()
        await safelyReturnIterator(iterator)
      }
    }
  })()
  return { subscriptionId, activeVariant: context.activeVariant.id }
}

async function unsubscribeVariantResource(
  app: AnyElysiaApp,
  params: Record<string, unknown>,
  options: NormalizedMcpPluginOptions,
  context: DispatchContext
): Promise<Record<string, never>> {
  if (!options.extensions.variants || !context.sessionId) {
    throw new JsonRpcError(-32601, 'Method not found: resources/unsubscribe')
  }
  if (typeof params.subscriptionId !== 'string') {
    throw new JsonRpcError(-32602, 'resources/unsubscribe requires subscriptionId')
  }
  const subscription = variantSessions(app, options)
    .get(context.sessionId)
    ?.subscriptions.get(params.subscriptionId)
  if (!subscription) throw new JsonRpcError(-32602, 'Unknown resource subscription')
  variantSessions(app, options).get(context.sessionId)?.subscriptions.delete(params.subscriptionId)
  await subscription.close?.()
  return {}
}

function emitVariantNotification(session: VariantSession, notification: unknown): void {
  const chunk = new TextEncoder().encode(
    `event: message\ndata: ${JSON.stringify({ jsonrpc: JSON_RPC_VERSION, ...(notification as object) })}\n\n`
  )
  for (const stream of session.streams.keys()) stream.enqueue(chunk)
}

async function listSkills(
  app: AnyElysiaApp,
  params: Record<string, unknown>,
  request: Request,
  options: NormalizedMcpPluginOptions,
  context: DispatchContext
): Promise<Record<string, unknown>> {
  assertModernSkills(app, options, context)
  const invocation = await invocationContext(request, 'skills/list', params, context, options)
  const config = options.extensions.skills
  if (config) enforceAuthorization(config.authorization, context.authorization, options)
  const staticSkills = Array.from(getMcpRegistry(app, options).skills.values()).filter(
    (skill) => skill.listed && isAuthorized(skill.authorization, context.authorization)
  )
  const pagination = config?.pagination
  if (!pagination && params.cursor !== undefined) {
    throw new JsonRpcError(-32602, 'Skills pagination is not configured')
  }
  const offset = pagination
    ? decodeCursor(params.cursor, 'skills/list', params, invocation, options, pagination)
    : 0
  if (offset < 0) throw new JsonRpcError(-32602, 'Invalid skills pagination cursor')
  const limit = pagination?.pageSize
  const visible: McpSkillDefinition[] = []
  const providerDefinitions: McpSkillDefinition[] = []
  let providerOffset = Math.max(0, offset - staticSkills.length)
  let providerTouched = offset >= staticSkills.length
  let hasMore = false

  if (offset < staticSkills.length) {
    const remaining = limit ?? staticSkills.length
    visible.push(...staticSkills.slice(offset, offset + remaining))
    hasMore = offset + visible.length < staticSkills.length || config?.provider !== undefined
  }

  if ((limit === undefined || visible.length < limit) && config?.provider) {
    providerTouched = true
    const providerLimit = limit === undefined ? undefined : limit - visible.length
    const page = await config.provider.list(
      {
        offset: providerOffset,
        limit: providerLimit === undefined ? undefined : Math.max(1, providerLimit)
      },
      invocation
    )
    if (
      !page ||
      !Array.isArray(page.skills) ||
      (page.hasMore !== undefined && typeof page.hasMore !== 'boolean')
    ) {
      throw new JsonRpcError(-32603, 'Skills provider returned an invalid page')
    }
    if (providerLimit !== undefined && page.skills.length > Math.max(1, providerLimit)) {
      throw new JsonRpcError(-32603, 'Skills provider exceeded the requested page size')
    }
    if (page.hasMore && page.skills.length === 0) {
      throw new JsonRpcError(-32603, 'Skills provider returned an empty non-terminal page')
    }
    providerOffset += page.skills.length
    for (const source of page.skills) {
      let definition: McpSkillDefinition
      try {
        definition = createProviderSkillDefinition(source)
        assertProviderDirectorySupport(config.provider, definition, config.directoryRead)
        assertCompatibleSkillDefinitions(
          [...getMcpRegistry(app, options).skills.values(), ...providerDefinitions],
          definition
        )
        await assertProviderAncestorCompatibility(
          config.provider,
          definition,
          invocation,
          [...getMcpRegistry(app, options).skills.values(), ...providerDefinitions, definition],
          config.directoryRead
        )
      } catch (error) {
        throw providerSkillError(error)
      }
      if (definition.listed && isAuthorized(definition.authorization, context.authorization)) {
        visible.push(definition)
      }
      providerDefinitions.push(definition)
    }
    hasMore = page.hasMore === true
  }

  if (!pagination && hasMore) {
    throw new JsonRpcError(-32603, 'Skills provider requires pagination configuration')
  }
  const nextOffset = providerTouched
    ? staticSkills.length + providerOffset
    : offset + visible.length
  const cache = config?.cache ?? { cacheScope: 'private' as const, ttlMs: 0 }
  return {
    resultType: 'complete',
    skills: visible.map((skill) => skill.entry),
    ttlMs: cache.ttlMs,
    cacheScope: cache.cacheScope,
    ...(hasMore
      ? {
          nextCursor: encodeCursor(
            'skills/list',
            nextOffset,
            params,
            invocation,
            options,
            pagination
          )
        }
      : {})
  }
}

async function getSkill(
  app: AnyElysiaApp,
  params: Record<string, unknown>,
  request: Request,
  options: NormalizedMcpPluginOptions,
  context: DispatchContext
): Promise<Record<string, unknown>> {
  assertModernSkills(app, options, context)
  const uri = params.uri
  if (typeof uri !== 'string') throw new JsonRpcError(-32602, 'skills/get requires a uri')
  try {
    assertSafeResourceUri(uri)
  } catch (error) {
    throw new JsonRpcError(-32602, 'Invalid skill URI', error)
  }
  const invocation = await invocationContext(request, 'skills/get', params, context, options)
  const registry = getMcpRegistry(app, options)
  let definition = registry.skills.get(uri)
  const config = options.extensions.skills
  if (!definition && config?.provider) {
    enforceAuthorization(config.authorization, context.authorization, options)
    const source = await config.provider.get(uri, invocation)
    if (source) {
      try {
        definition = createProviderSkillDefinition(source)
        assertProviderDirectorySupport(config.provider, definition, config.directoryRead)
        assertCompatibleSkillDefinitions(registry.skills.values(), definition)
        await assertProviderAncestorCompatibility(
          config.provider,
          definition,
          invocation,
          [...registry.skills.values(), definition],
          config.directoryRead
        )
      } catch (error) {
        throw providerSkillError(error)
      }
      if (definition.uri !== uri) {
        throw new JsonRpcError(-32603, 'Skills provider returned a different skill URI')
      }
    }
  }
  if (!definition) throw new JsonRpcError(-32602, `No skill is served at ${uri}`)
  if (config) enforceAuthorization(config.authorization, context.authorization, options)
  enforceAuthorization(definition.authorization, context.authorization, options)
  const cache = config?.cache ?? { cacheScope: 'private' as const, ttlMs: 0 }
  return {
    resultType: 'complete',
    skill: definition.entry,
    ttlMs: cache.ttlMs,
    cacheScope: cache.cacheScope
  }
}

async function readSkillResource(
  app: AnyElysiaApp,
  uri: string,
  params: Record<string, unknown>,
  request: Request,
  options: NormalizedMcpPluginOptions,
  context: DispatchContext
): Promise<Record<string, unknown> | undefined> {
  const registry = getMcpRegistry(app, options)
  try {
    assertSafeResourceUri(uri)
  } catch {
    return undefined
  }
  const local = findStaticSkillResource(registry.skills.values(), uri)
  if (local) {
    if (options.extensions.skills) {
      enforceAuthorization(options.extensions.skills.authorization, context.authorization, options)
    }
    enforceAuthorization(local.skill.authorization, context.authorization, options)
    return { contents: [serializeSkillResource(local.resource)] }
  }
  const localDynamic = findStaticDynamicSkill(registry.skills.values(), uri)
  if (localDynamic) {
    if (options.extensions.skills) {
      enforceAuthorization(options.extensions.skills.authorization, context.authorization, options)
    }
    enforceAuthorization(localDynamic.authorization, context.authorization, options)
    if (!localDynamic.readResource) return undefined
    const invocation = await invocationContext(request, 'resources/read', params, context, options)
    const value = await localDynamic.readResource(uri, invocation)
    if (value === null) return undefined
    return {
      contents: [serializeDynamicSkillResource(uri, value, localDynamic.allowBinary)]
    }
  }
  const config = options.extensions.skills
  if (!config?.provider) return undefined
  enforceAuthorization(config.authorization, context.authorization, options)
  const invocation = await invocationContext(request, 'resources/read', params, context, options)
  const owner = await providerSkillOwner(
    config.provider,
    uri,
    invocation,
    registry.skills.values(),
    false,
    config.directoryRead
  )
  if (!owner) return undefined
  enforceAuthorization(owner.authorization, context.authorization, options)
  const stable = owner.files.get(uri)
  if (stable) return { contents: [serializeSkillResource(stable)] }
  if (owner.entry.resources !== 'dynamic') return undefined
  const value = await config.provider.read(uri, invocation)
  if (value === null) return undefined
  return { contents: [serializeDynamicSkillResource(uri, value, owner.allowBinary)] }
}

async function readSkillDirectory(
  app: AnyElysiaApp,
  params: Record<string, unknown>,
  request: Request,
  options: NormalizedMcpPluginOptions,
  context: DispatchContext
): Promise<Record<string, unknown>> {
  assertModernSkills(app, options, context)
  const config = options.extensions.skills
  if (!config?.directoryRead) {
    throw new JsonRpcError(-32601, 'Method not found: resources/directory/read', undefined, 404)
  }
  const uri = params.uri
  if (typeof uri !== 'string') throw new JsonRpcError(-32602, 'Directory read requires a uri')
  try {
    assertSafeDirectoryUri(uri)
  } catch (error) {
    throw new JsonRpcError(-32602, 'Invalid skill directory URI', error)
  }
  enforceAuthorization(config.authorization, context.authorization, options)
  const invocation = await invocationContext(
    request,
    'resources/directory/read',
    params,
    context,
    options
  )
  const pagination = config.pagination
  if (!pagination && params.cursor !== undefined) {
    throw new JsonRpcError(-32602, 'Skills directory pagination is not configured')
  }
  const offset = pagination
    ? decodeCursor(
        params.cursor,
        'resources/directory/read',
        params,
        invocation,
        options,
        pagination
      )
    : 0
  const registry = getMcpRegistry(app, options)
  const namespaceOwner = findSkillDirectoryOwner(registry.skills.values(), uri)
  const local = listStaticSkillDirectory(registry.skills.values(), uri)
  let entries: readonly McpSkillDirectoryEntry[] | undefined
  let hasMore = false
  if (namespaceOwner?.entry.resources === 'dynamic') {
    enforceAuthorization(namespaceOwner.authorization, context.authorization, options)
    if (!namespaceOwner.readDirectory) {
      throw new JsonRpcError(-32603, 'Dynamic skill does not implement directory enumeration')
    }
    const page = await readDynamicSkillDirectoryPage(
      namespaceOwner.readDirectory,
      uri,
      local?.skill === namespaceOwner ? local.entries : [],
      offset,
      pagination?.pageSize,
      invocation,
      namespaceOwner
    )
    if (!page) throw new JsonRpcError(-32602, `${uri} is not a directory resource`)
    entries = page.entries
    hasMore = page.hasMore
  } else if (namespaceOwner && local?.skill === namespaceOwner) {
    enforceAuthorization(namespaceOwner.authorization, context.authorization, options)
    const end = pagination
      ? Math.min(offset + pagination.pageSize, local.entries.length)
      : local.entries.length
    if (offset > local.entries.length) throw new JsonRpcError(-32602, 'Invalid directory cursor')
    entries = local.entries.slice(offset, end)
    hasMore = end < local.entries.length
  } else if (config.provider) {
    const owner = await providerSkillOwner(
      config.provider,
      uri,
      invocation,
      registry.skills.values(),
      true,
      config.directoryRead
    )
    if (!owner) throw new JsonRpcError(-32602, `${uri} is not a directory resource`)
    enforceAuthorization(owner.authorization, context.authorization, options)
    const computed = listStaticSkillDirectory([owner], uri)
    if (computed && owner.entry.resources !== 'dynamic') {
      const end = pagination
        ? Math.min(offset + pagination.pageSize, computed.entries.length)
        : computed.entries.length
      entries = computed.entries.slice(offset, end)
      hasMore = end < computed.entries.length
    } else if (owner.entry.resources === 'dynamic') {
      if (!config.provider.readDirectory) {
        throw new JsonRpcError(-32603, 'Skills provider does not implement directory enumeration')
      }
      const page = await readDynamicSkillDirectoryPage(
        config.provider.readDirectory.bind(config.provider),
        uri,
        computed?.entries ?? [],
        offset,
        pagination?.pageSize,
        invocation,
        owner
      )
      if (!page) throw new JsonRpcError(-32602, `${uri} is not a directory resource`)
      entries = page.entries
      hasMore = page.hasMore
    }
  }
  if (!entries) throw new JsonRpcError(-32602, `${uri} is not a directory resource`)
  if (!pagination && hasMore)
    throw new JsonRpcError(-32603, 'Dynamic directory reader requires pagination configuration')
  return {
    resultType: 'complete',
    resources: entries,
    ...(hasMore
      ? {
          nextCursor: encodeCursor(
            'resources/directory/read',
            offset + entries.length,
            params,
            invocation,
            options,
            pagination
          )
        }
      : {})
  }
}

function assertModernSkills(
  app: AnyElysiaApp,
  options: NormalizedMcpPluginOptions,
  context: DispatchContext
): void {
  if (!context.protocol.modern) {
    throw new JsonRpcError(-32601, 'Skills require protocol version 2026-07-28', undefined, 404)
  }
  if (getMcpRegistry(app, options).skills.size === 0 && !options.extensions.skills?.provider) {
    throw new JsonRpcError(-32601, 'Skills extension is not enabled', undefined, 404)
  }
}

async function readDynamicSkillDirectoryPage(
  reader: McpSkillDynamicDirectoryReader,
  uri: string,
  knownEntries: readonly McpSkillDirectoryEntry[],
  offset: number,
  pageSize: number | undefined,
  context: McpInvocationContext,
  owner: McpSkillDefinition
): Promise<{ entries: McpSkillDirectoryEntry[]; hasMore: boolean } | undefined> {
  const entries =
    offset < knownEntries.length
      ? knownEntries.slice(offset, pageSize === undefined ? undefined : offset + pageSize)
      : []
  if (pageSize !== undefined && entries.length === pageSize) {
    return { entries, hasMore: true }
  }

  const dynamicOffset = Math.max(0, offset - knownEntries.length)
  const dynamicLimit = pageSize === undefined ? undefined : pageSize - entries.length
  const page = await reader(uri, { offset: dynamicOffset, limit: dynamicLimit }, context)
  if (!page) {
    return knownEntries.length > 0 && offset <= knownEntries.length
      ? { entries, hasMore: false }
      : undefined
  }
  if (
    !Array.isArray(page.resources) ||
    (page.hasMore !== undefined && typeof page.hasMore !== 'boolean') ||
    (dynamicLimit !== undefined && page.resources.length > dynamicLimit) ||
    (page.hasMore && page.resources.length === 0)
  ) {
    throw new JsonRpcError(-32603, 'Dynamic skill directory reader returned an invalid page')
  }
  const dynamicEntries = validateSkillDirectoryEntries(page.resources, uri, owner)
  const knownUris = new Set(knownEntries.map((entry) => entry.uri))
  if (dynamicEntries.some((entry) => knownUris.has(entry.uri))) {
    throw new JsonRpcError(
      -32603,
      'Dynamic skill directory reader returned an adapter-managed resource'
    )
  }
  entries.push(...dynamicEntries)
  return { entries, hasMore: page.hasMore === true }
}

async function providerSkillOwner(
  provider: NonNullable<
    NonNullable<NormalizedMcpPluginOptions['extensions']['skills']>['provider']
  >,
  resourceUri: string,
  context: McpInvocationContext,
  existing: Iterable<McpSkillDefinition>,
  includeSelf = false,
  directoryRead = false
): Promise<McpSkillDefinition | undefined> {
  const candidates = candidateSkillUris(resourceUri, includeSelf)
  const known = [...existing]
  let owner: McpSkillDefinition | undefined
  for (const candidate of candidates) {
    const source = await provider.get(candidate, context)
    if (!source) continue
    let definition: McpSkillDefinition
    try {
      definition = createProviderSkillDefinition(source)
      assertProviderDirectorySupport(provider, definition, directoryRead)
      assertCompatibleSkillDefinitions(known, definition)
    } catch (error) {
      throw providerSkillError(error)
    }
    if (definition.uri !== candidate || !isWithinSkill(definition.rootUri, resourceUri)) {
      throw new JsonRpcError(-32603, 'Skills provider violated resource ownership')
    }
    owner ??= definition
    known.push(definition)
  }
  return owner
}

async function assertProviderAncestorCompatibility(
  provider: NonNullable<
    NonNullable<NormalizedMcpPluginOptions['extensions']['skills']>['provider']
  >,
  definition: McpSkillDefinition,
  context: McpInvocationContext,
  existing: readonly McpSkillDefinition[],
  directoryRead: boolean
): Promise<void> {
  const known = [...existing]
  for (const candidate of candidateSkillUris(definition.rootUri, false)) {
    if (known.some((skill) => skill.uri === candidate)) continue
    const source = await provider.get(candidate, context)
    if (!source) continue
    const ancestor = createProviderSkillDefinition(source)
    assertProviderDirectorySupport(provider, ancestor, directoryRead)
    if (ancestor.uri !== candidate) {
      throw new TypeError('Skills provider returned a different ancestor skill URI')
    }
    assertCompatibleSkillDefinitions(known, ancestor)
    known.push(ancestor)
  }
}

function assertProviderDirectorySupport(
  provider: NonNullable<
    NonNullable<NormalizedMcpPluginOptions['extensions']['skills']>['provider']
  >,
  definition: McpSkillDefinition,
  directoryRead: boolean
): void {
  if (directoryRead && definition.entry.resources === 'dynamic' && !provider.readDirectory) {
    throw new MissingProviderDirectoryReaderError(
      `Dynamic provider skill ${definition.uri} requires readDirectory when directoryRead is enabled`
    )
  }
}

class MissingProviderDirectoryReaderError extends Error {}

function providerSkillError(error: unknown): JsonRpcError {
  return error instanceof MissingProviderDirectoryReaderError
    ? new JsonRpcError(-32603, error.message)
    : new JsonRpcError(-32603, 'Skills provider returned an invalid skill', error)
}

function candidateSkillUris(uri: string, includeSelf: boolean): string[] {
  const values: string[] = []
  if (includeSelf) values.push(`${uri}/SKILL.md`)
  let cursor = uri.lastIndexOf('/')
  while (cursor > uri.indexOf('://') + 2) {
    const directory = uri.slice(0, cursor)
    values.push(`${directory}/SKILL.md`)
    cursor = directory.lastIndexOf('/')
  }
  return [...new Set(values)]
}

function validateSkillDirectoryEntries(
  entries: readonly McpSkillDirectoryEntry[],
  directoryUri: string,
  owner: McpSkillDefinition
): McpSkillDirectoryEntry[] {
  if (!Array.isArray(entries))
    throw new JsonRpcError(-32603, 'Directory provider returned invalid resources')
  const prefix = `${directoryUri}/`
  const seen = new Set<string>()
  return entries.map((entry) => {
    if (!entry || typeof entry.uri !== 'string' || typeof entry.name !== 'string') {
      throw new JsonRpcError(-32603, 'Directory provider returned an invalid resource')
    }
    if (entry.mimeType !== undefined && typeof entry.mimeType !== 'string') {
      throw new JsonRpcError(-32603, 'Directory provider returned an invalid MIME type')
    }
    if (entry.size !== undefined && (!Number.isSafeInteger(entry.size) || entry.size < 0)) {
      throw new JsonRpcError(-32603, 'Directory provider returned an invalid resource size')
    }
    if (seen.has(entry.uri)) {
      throw new JsonRpcError(-32603, 'Directory provider returned a duplicate resource')
    }
    seen.add(entry.uri)
    try {
      assertSafeResourceUri(entry.uri)
    } catch (error) {
      throw new JsonRpcError(-32603, 'Directory provider returned an unsafe resource URI', error)
    }
    const remainder = entry.uri.startsWith(prefix) ? entry.uri.slice(prefix.length) : ''
    if (!remainder || remainder.includes('/') || !isWithinSkill(owner.rootUri, entry.uri)) {
      throw new JsonRpcError(-32603, 'Directory provider returned a non-child resource')
    }
    if (decodeURIComponent(remainder) !== entry.name) {
      throw new JsonRpcError(-32603, 'Directory provider resource name does not match its URI')
    }
    return {
      uri: entry.uri,
      name: entry.name,
      ...(entry.mimeType !== undefined ? { mimeType: entry.mimeType } : {}),
      ...(entry.size !== undefined ? { size: entry.size } : {})
    }
  })
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
  if (!isRecord(params.ref) || !isRecord(params.argument)) {
    throw new JsonRpcError(-32602, 'completion/complete requires ref and argument')
  }
  const argument = params.argument
  if (typeof argument.name !== 'string' || typeof argument.value !== 'string') {
    throw new JsonRpcError(-32602, 'completion argument requires string name and value')
  }
  const registry = getMcpRegistry(app, options)
  const type = params.ref.type
  const target =
    type === 'ref/prompt' && typeof params.ref.name === 'string'
      ? registry.prompts.get(params.ref.name)
      : type === 'ref/resource' && typeof params.ref.uri === 'string'
        ? registry.resourceTemplates.get(params.ref.uri)
        : undefined
  if (!target?.complete) throw new JsonRpcError(-32602, 'Completion target is unavailable')
  if (
    (type === 'ref/prompt' &&
      !variantAllows(context.activeVariant, 'prompts', String(params.ref.name))) ||
    (type === 'ref/resource' &&
      !variantAllows(context.activeVariant, 'resources', String(params.ref.uri)))
  ) {
    throw variantUnknown('Completion target is unavailable', context)
  }
  enforceAuthorization(target.authorization, context.authorization, options)
  const completion = await target.complete(
    {
      ref: params.ref as any,
      argument: { name: argument.name, value: argument.value },
      context: isRecord(params.context)
        ? {
            arguments: isRecord(params.context.arguments)
              ? Object.fromEntries(
                  Object.entries(params.context.arguments).filter(
                    (entry): entry is [string, string] => typeof entry[1] === 'string'
                  )
                )
              : undefined
          }
        : undefined
    },
    await invocationContext(request, 'completion/complete', params, context, options)
  )
  if (
    !Array.isArray(completion.values) ||
    completion.values.length > 100 ||
    !completion.values.every((value) => typeof value === 'string') ||
    (completion.total !== undefined &&
      (!Number.isSafeInteger(completion.total) || completion.total < 0)) ||
    (completion.hasMore !== undefined && typeof completion.hasMore !== 'boolean')
  ) {
    throw new JsonRpcError(-32603, 'Completion callback returned an invalid completion result')
  }
  return { completion }
}

function hasCompletion(registry: ReturnType<typeof getMcpRegistry>): boolean {
  return (
    Array.from(registry.prompts.values()).some((item) => item.complete) ||
    Array.from(registry.resourceTemplates.values()).some((item) => item.complete)
  )
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

function invocationContextBase(
  request: Request,
  params: Record<string, unknown>,
  context: DispatchContext
): McpInvocationContext {
  return {
    request,
    signal: context.signal ?? request.signal,
    meta: isRecord(params._meta) ? params._meta : undefined,
    protocolVersion: context.protocol.version,
    clientCapabilities: context.protocol.clientCapabilities,
    clientInfo: context.protocol.clientInfo,
    authorization: context.authorization,
    reportProgress: context.reportProgress
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

async function handleSubscription(
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
      throw new JsonRpcError(-32601, 'subscriptions/listen requires MCP 2026-07-28', undefined, 404)
    if (!options.core.subscriptions || !notifications) {
      throw new JsonRpcError(-32601, 'Core subscriptions are not configured', undefined, 404)
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
  let subscribed: URL
  let updated: URL
  try {
    subscribed = new URL(subscribedUri)
    updated = new URL(updatedUri)
  } catch {
    return false
  }
  if (
    subscribed.protocol !== updated.protocol ||
    subscribed.username !== updated.username ||
    subscribed.password !== updated.password ||
    subscribed.host !== updated.host ||
    subscribed.search !== updated.search ||
    subscribed.hash !== updated.hash
  ) {
    return false
  }
  const basePath = subscribed.pathname.endsWith('/')
    ? subscribed.pathname
    : `${subscribed.pathname}/`
  return updated.pathname.startsWith(basePath)
}

function acceptedCoreSubscriptionFilter(
  app: AnyElysiaApp,
  notifications: Record<string, unknown>,
  options: NormalizedMcpPluginOptions,
  authorization?: McpAuthorizationContext
): Record<string, unknown> {
  const configured = options.core.subscriptions
  if (!configured) {
    throw new JsonRpcError(-32601, 'Core subscriptions are not configured', undefined, 404)
  }
  for (const key of ['toolsListChanged', 'promptsListChanged', 'resourcesListChanged']) {
    const value = notifications[key]
    if (value !== undefined && typeof value !== 'boolean') {
      throw new JsonRpcError(-32602, `${key} must be boolean`)
    }
  }
  const requestedResources = notifications.resourceSubscriptions
  if (
    requestedResources !== undefined &&
    (!Array.isArray(requestedResources) ||
      !requestedResources.every((uri) => typeof uri === 'string'))
  ) {
    throw new JsonRpcError(-32602, 'resourceSubscriptions must contain only strings')
  }
  const acceptedResources = requestedResources?.filter((uri) => {
    const reader = findResourceReader(getMcpRegistry(app, options), uri)
    return Boolean(
      configured.resources && reader && isAuthorized(reader.definition.authorization, authorization)
    )
  })
  return pruneUndefined({
    toolsListChanged:
      notifications.toolsListChanged === true && configured.toolsListChanged ? true : undefined,
    promptsListChanged:
      notifications.promptsListChanged === true && configured.promptsListChanged ? true : undefined,
    resourcesListChanged:
      notifications.resourcesListChanged === true && configured.resourcesListChanged
        ? true
        : undefined,
    resourceSubscriptions: acceptedResources ? [...new Set(acceptedResources)] : undefined
  })
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
    throw new JsonRpcError(-32601, 'Core subscriptions are not configured', undefined, 404)
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

async function handleMixedSubscription(
  app: AnyElysiaApp,
  payload: JsonRpcRequest,
  request: Request,
  options: NormalizedMcpPluginOptions,
  authorization?: McpAuthorizationContext
): Promise<Response> {
  let setupAbort: AbortController | undefined
  let setupCloseTasks: (() => Promise<void>) | undefined
  let setupIterator: AsyncIterator<McpServerNotification> | undefined
  let setupUnlink: (() => void) | undefined
  let streamEstablished = false
  try {
    if (!isRequestId(payload.id)) {
      throw new JsonRpcError(-32600, 'Invalid Request', undefined, 400)
    }
    const { context, meta, params, protocol } = prepareTaskSubscriptionRequest(
      request,
      payload,
      options,
      authorization
    )
    const notifications = isRecord(params.notifications) ? params.notifications : {}
    taskController(options).assertClientCapability(meta)
    const taskIds = notifications.taskIds
    if (
      !Array.isArray(taskIds) ||
      !taskIds.every((value): value is string => typeof value === 'string')
    ) {
      throw new JsonRpcError(-32602, 'notifications.taskIds must contain only strings')
    }
    const {
      accepted: acceptedCore,
      abort,
      configured,
      iterator,
      unlinkIncomingAbort
    } = await openCoreSubscription(
      app,
      request,
      params,
      notifications,
      options,
      protocol,
      authorization
    )
    setupAbort = abort
    setupIterator = iterator
    setupUnlink = unlinkIncomingAbort
    const queuedTasks: DetailedTask[] = []
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined
    let acceptedTasks: Set<string> | undefined
    let closed = false
    let heartbeat: ReturnType<typeof setInterval> | undefined
    const encoder = new TextEncoder()
    const subscriptionId = payload.id
    const event = (message: unknown) => encodeSseEvent(encoder, message)
    const emitTask = (task: DetailedTask) => {
      if (closed) return
      if (acceptedTasks && !acceptedTasks.has(task.taskId)) {
        if (streamController) {
          streamController.enqueue(
            event(subscriptionCancelled(subscriptionId, 'Task subscription provider failed'))
          )
          streamController.enqueue(event(subscriptionComplete(subscriptionId, options)))
          streamController.close()
        }
        closed = true
        abort.abort('Task subscription provider failed')
        unlinkIncomingAbort()
        void safelyReturnIterator(iterator)
        void setupCloseTasks?.()
        return
      }
      if (!streamController) {
        queuedTasks.push(task)
        return
      }
      streamController.enqueue(
        event({
          jsonrpc: JSON_RPC_VERSION,
          method: 'notifications/tasks',
          params: {
            ...task,
            _meta: { 'io.modelcontextprotocol/subscriptionId': subscriptionId }
          }
        })
      )
    }
    const tasks = await taskController(options).listen(
      taskIds,
      emitTask,
      taskRequestContext(request, params, { ...context, signal: abort.signal })
    )
    let closeTasksPromise: Promise<void> | undefined
    const closeTasksOnAbort = () => void setupCloseTasks?.()
    setupCloseTasks = () => {
      abort.signal.removeEventListener('abort', closeTasksOnAbort)
      closeTasksPromise ??= safelyCloseTaskSubscription(tasks)
      return closeTasksPromise
    }
    if (abort.signal.aborted) closeTasksOnAbort()
    else abort.signal.addEventListener('abort', closeTasksOnAbort, { once: true })
    const acceptedTaskIds = acceptedSubscriptionTaskIds(tasks, taskIds)
    acceptedTasks = new Set(acceptedTaskIds)
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller
        controller.enqueue(
          event({
            jsonrpc: JSON_RPC_VERSION,
            method: 'notifications/subscriptions/acknowledged',
            params: {
              notifications: { ...acceptedCore, taskIds: acceptedTaskIds },
              _meta: { 'io.modelcontextprotocol/subscriptionId': subscriptionId }
            }
          })
        )
        for (const task of queuedTasks) emitTask(task)
        queuedTasks.length = 0
        heartbeat = setInterval(() => {
          if (!closed) controller.enqueue(encoder.encode(': heartbeat\n\n'))
        }, configured.heartbeatMs)
        const coreDone = (async () => {
          for (;;) {
            const next = await iterator.next()
            if (next.done || closed) return
            if (!isAllowedNotification(next.value, acceptedCore, app, options, authorization)) {
              throw new Error(
                `Subscription provider emitted unrequested notification: ${next.value.method}`
              )
            }
            controller.enqueue(
              event({
                jsonrpc: JSON_RPC_VERSION,
                method: next.value.method,
                params: {
                  ...(next.value.params ?? {}),
                  _meta: { 'io.modelcontextprotocol/subscriptionId': subscriptionId }
                }
              })
            )
          }
        })()
        if (tasks?.done) {
          void Promise.all([coreDone, tasks.done])
            .then(() => {
              if (closed) return
              controller.enqueue(
                event(subscriptionCancelled(subscriptionId, 'Subscription ended by server'))
              )
              controller.enqueue(event(subscriptionComplete(subscriptionId, options)))
              closed = true
              unlinkIncomingAbort()
              if (heartbeat) clearInterval(heartbeat)
              void setupCloseTasks?.()
              controller.close()
            })
            .catch(() => {
              if (closed) return
              controller.enqueue(
                event(subscriptionCancelled(subscriptionId, 'Subscription provider failed'))
              )
              controller.enqueue(event(subscriptionComplete(subscriptionId, options)))
              closed = true
              unlinkIncomingAbort()
              if (heartbeat) clearInterval(heartbeat)
              abort.abort('Subscription provider failed')
              void safelyReturnIterator(iterator)
              void setupCloseTasks?.()
              controller.close()
            })
        } else {
          void coreDone.catch(() => {
            if (closed) return
            controller.enqueue(
              event(subscriptionCancelled(subscriptionId, 'Subscription provider failed'))
            )
            controller.enqueue(event(subscriptionComplete(subscriptionId, options)))
            closed = true
            unlinkIncomingAbort()
            if (heartbeat) clearInterval(heartbeat)
            abort.abort('Subscription provider failed')
            void safelyReturnIterator(iterator)
            void setupCloseTasks?.()
            controller.close()
          })
        }
      },
      cancel() {
        closed = true
        abort.abort('MCP subscription stream closed')
        unlinkIncomingAbort()
        if (heartbeat) clearInterval(heartbeat)
        void safelyReturnIterator(iterator)
        void setupCloseTasks?.()
      }
    })
    const response = sseResponse(body)
    streamEstablished = true
    return response
  } catch (error) {
    if (!streamEstablished && setupAbort) {
      setupAbort.abort('Mixed subscription setup failed')
      setupUnlink?.()
      await Promise.all([
        safelyReturnIterator(setupIterator),
        setupCloseTasks?.() ?? Promise.resolve()
      ])
    }
    return jsonResponse(
      normalizeDispatchError(errorIdForRequest(request, options, payload), error),
      errorStatus(error)
    )
  }
}

function sseResponse(body: ReadableStream<Uint8Array>): Response {
  return new Response(body, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no',
      connection: 'keep-alive'
    }
  })
}

function linkAbortSignal(source: AbortSignal, target: AbortController): () => void {
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

async function handleTaskSubscription(
  app: AnyElysiaApp,
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
  try {
    const { context, meta, params } = prepareTaskSubscriptionRequest(
      request,
      payload,
      options,
      authorization
    )
    const controller = taskController(options)
    controller.assertClientCapability(meta)
    if (!isRecord(params.notifications) || !Array.isArray(params.notifications.taskIds)) {
      throw new JsonRpcError(-32602, 'subscriptions/listen requires notifications.taskIds')
    }
    const taskIds = params.notifications.taskIds
    if (!taskIds.every((value): value is string => typeof value === 'string')) {
      throw new JsonRpcError(-32602, 'notifications.taskIds must contain only strings')
    }
    const subscriptionId = payload.id
    const encoder = new TextEncoder()
    let closed = false
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined
    let accepted: Set<string> | undefined
    let subscription: TaskSubscription | undefined
    let cleanupPromise: Promise<void> | undefined
    const abort = new AbortController()
    const unlinkIncomingAbort = linkAbortSignal(request.signal, abort)
    const detachAbort = () => {
      unlinkIncomingAbort()
      abort.signal.removeEventListener('abort', handleAbort)
    }
    const closeSubscription = () => {
      detachAbort()
      if (!subscription) return Promise.resolve()
      cleanupPromise ??= safelyCloseTaskSubscription(subscription)
      return cleanupPromise
    }
    const handleAbort = () => {
      closed = true
      void closeSubscription()
      try {
        streamController?.close()
      } catch {
        // The response stream may already be closed by another terminal path.
      }
    }
    if (!abort.signal.aborted) {
      abort.signal.addEventListener('abort', handleAbort, { once: true })
    }
    const queuedTasks: DetailedTask[] = []
    const event = (message: unknown) =>
      encoder.encode(`event: message\ndata: ${JSON.stringify(message)}\n\n`)
    const enqueueTask = (task: DetailedTask) => {
      if (closed) return
      if (accepted && !accepted.has(task.taskId)) {
        if (streamController) {
          streamController.enqueue(
            event(subscriptionCancelled(subscriptionId, 'Task subscription provider failed'))
          )
          streamController.enqueue(event(subscriptionComplete(subscriptionId, options)))
          streamController.close()
        }
        closed = true
        void closeSubscription()
        return
      }
      if (!streamController) {
        queuedTasks.push(task)
        return
      }
      streamController.enqueue(
        event({
          jsonrpc: JSON_RPC_VERSION,
          method: 'notifications/tasks',
          params: {
            ...task,
            _meta: {
              'io.modelcontextprotocol/subscriptionId': subscriptionId
            }
          }
        })
      )
    }
    try {
      subscription = await controller.listen(
        taskIds,
        enqueueTask,
        taskRequestContext(request, params, { ...context, signal: abort.signal })
      )
    } catch (error) {
      abort.abort('Task subscription setup failed')
      detachAbort()
      throw error
    }
    if (abort.signal.aborted) {
      closed = true
      await closeSubscription()
    }
    let acceptedTaskIds: string[]
    try {
      acceptedTaskIds = acceptedSubscriptionTaskIds(subscription, taskIds)
    } catch (error) {
      await closeSubscription()
      throw error
    }
    accepted = new Set(acceptedTaskIds)
    if (queuedTasks.some((task) => !accepted.has(task.taskId))) {
      await closeSubscription()
      throw new Error('Task provider emitted a notification for an unaccepted task')
    }
    const body = new ReadableStream<Uint8Array>({
      async start(stream) {
        streamController = stream
        if (closed) {
          stream.close()
          return
        }
        stream.enqueue(
          event({
            jsonrpc: JSON_RPC_VERSION,
            method: 'notifications/subscriptions/acknowledged',
            params: {
              notifications: { taskIds: acceptedTaskIds },
              _meta: {
                'io.modelcontextprotocol/subscriptionId': subscriptionId
              }
            }
          })
        )
        for (const task of queuedTasks) enqueueTask(task)
        queuedTasks.length = 0
        if (!subscription || subscription.done) {
          try {
            await subscription?.done
          } catch {
            if (closed) return
            stream.enqueue(
              event(subscriptionCancelled(subscriptionId, 'Task subscription provider failed'))
            )
            stream.enqueue(event(subscriptionComplete(subscriptionId, options)))
            closed = true
            stream.close()
            await closeSubscription()
            return
          }
          if (closed) return
          stream.enqueue(
            event(subscriptionCancelled(subscriptionId, 'Subscription ended by server'))
          )
          stream.enqueue(event(subscriptionComplete(subscriptionId, options)))
          closed = true
          await closeSubscription()
          stream.close()
        }
      },
      async cancel() {
        closed = true
        abort.abort('MCP subscription stream closed')
        await closeSubscription()
      }
    })
    void app
    return new Response(body, {
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        'x-accel-buffering': 'no',
        connection: 'keep-alive'
      }
    })
  } catch (error) {
    return jsonResponse(
      normalizeDispatchError(errorIdForRequest(request, options, payload), error),
      errorStatus(error)
    )
  }
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

async function safelyReturnIterator(
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
  let html = content.text
  if (html === undefined && content.blob !== undefined) {
    try {
      if (
        content.blob.length % 4 !== 0 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(content.blob)
      ) {
        throw new TypeError('invalid base64')
      }
      html = Buffer.from(content.blob, 'base64').toString('utf8')
    } catch {
      throw new TypeError('MCP App blob content must be valid base64 HTML')
    }
  }
  if (
    typeof html !== 'string' ||
    !/^\s*<!doctype html>/iu.test(html) ||
    !/<html(?:\s|>)/iu.test(html) ||
    !/<\/html>\s*$/iu.test(html)
  ) {
    throw new TypeError('MCP App resources must contain a complete HTML5 document')
  }
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

async function serializeProtocolResult(
  method: string,
  result: unknown,
  protocol: McpRequestProtocolContext,
  params: Record<string, unknown>,
  context: McpInvocationContext,
  options: NormalizedMcpPluginOptions
): Promise<unknown> {
  if (!isRecord(result)) return result
  if (method === 'tools/call') assertTrustResultMetadata(result._meta)
  if (!protocol.modern) {
    if (isInputRequiredResult(result)) {
      throw new JsonRpcError(-32603, 'Input-required results require MCP 2026-07-28')
    }
    return result
  }
  const prepared = prepareInputRequiredResult(result, method, params, context, options)
  if (isInputRequiredResult(prepared)) {
    return {
      ...prepared,
      _meta: { ...modernResultMeta(options), ...(prepared._meta ?? {}) }
    }
  }
  const complete = {
    ...result,
    resultType: result.resultType === 'task' ? 'task' : 'complete',
    _meta: {
      ...modernResultMeta(options),
      ...(isRecord(result._meta) ? result._meta : {})
    }
  }
  if (
    method === 'server/discover' ||
    method === 'tools/list' ||
    method === 'resources/list' ||
    method === 'resources/templates/list' ||
    method === 'resources/read' ||
    method === 'prompts/list'
  ) {
    if (params.inputResponses !== undefined || params.requestState !== undefined) return complete
    const policy = await cachePolicy(method, context, options)
    return {
      ...complete,
      ...policy
    }
  }
  return complete
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

async function handleLegacyAuxiliaryMethod(
  app: AnyElysiaApp,
  request: Request,
  options: NormalizedMcpPluginOptions,
  authorization?: McpAuthorizationContext
): Promise<Response> {
  if (request.method === 'GET') {
    if (!options.transport.enableGetSse) {
      return new Response(null, { status: 405, headers: { allow: 'POST, GET, DELETE' } })
    }
    if (!options.extensions.variants && !options.extensions.events) return createEmptySseResponse()
    const sessionId = request.headers.get('mcp-session-id')
    const session = sessionId ? variantSessions(app, options).get(sessionId) : undefined
    const principal = variantPrincipal(authorization)
    if (options.extensions.variants && (!session || session.principal !== principal)) {
      return jsonResponse(createErrorResponse(null, -32602, 'Unknown MCP session'), 400)
    }
    const encoder = new TextEncoder()
    let streamController: ReadableStreamDefaultController<Uint8Array>
    let heartbeatTimer: ReturnType<typeof setInterval> | undefined
    let detachEvents: (() => void) | undefined
    const closeStream = () => {
      if (heartbeatTimer) clearInterval(heartbeatTimer)
      session?.streams.delete(streamController)
      detachEvents?.()
      try {
        streamController.close()
      } catch {
        // The consumer may have already cancelled the stream.
      }
    }
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller
        const heartbeat = setInterval(() => {
          controller.enqueue(encoder.encode(': heartbeat\n\n'))
        }, options.core.subscriptions?.heartbeatMs ?? 15_000)
        heartbeatTimer = heartbeat
        session?.streams.set(controller, heartbeat)
        detachEvents = sessionId
          ? attachEventSessionStream(app, sessionId, principal, controller, closeStream, options)
          : undefined
        if (options.extensions.events && !detachEvents) {
          clearInterval(heartbeat)
          controller.error(new Error('Unknown MCP event session'))
          return
        }
        controller.enqueue(encoder.encode(': connected\n\n'))
        if (request.signal.aborted) closeStream()
        else request.signal.addEventListener('abort', closeStream, { once: true })
      },
      cancel() {
        closeStream()
      }
    })
    return new Response(body, {
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'mcp-session-id': sessionId as string
      }
    })
  }
  if (!options.transport.enableDeleteSession) {
    return new Response(null, { status: 405, headers: { allow: 'POST, GET, DELETE' } })
  }
  if (options.extensions.variants) {
    const sessionId = request.headers.get('mcp-session-id')
    const session = sessionId ? variantSessions(app, options).get(sessionId) : undefined
    const principal = variantPrincipal(authorization)
    if (options.extensions.variants && (!session || session.principal !== principal)) {
      return jsonResponse(createErrorResponse(null, -32602, 'Unknown MCP session'), 400)
    }
    if (!session) return jsonResponse(createErrorResponse(null, -32602, 'Unknown MCP session'), 400)
    for (const [controller, heartbeat] of session.streams) {
      clearInterval(heartbeat)
      controller.close()
    }
    session.streams.clear()
    await Promise.allSettled(
      [...session.subscriptions.values()].map((subscription) => subscription.close?.())
    )
    variantSessions(app, options).delete(sessionId as string)
  }
  if (options.extensions.events) {
    const sessionId = request.headers.get('mcp-session-id')
    if (!sessionId || !deleteEventSession(app, sessionId, variantPrincipal(authorization), options))
      return jsonResponse(createErrorResponse(null, -32602, 'Unknown MCP session'), 400)
  }
  return new Response(null, { status: 202 })
}

function variantSessions(
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

function variantPrincipal(authorization?: McpAuthorizationContext): string | undefined {
  const principal = authorization?.principal
  return principal
    ? JSON.stringify([
        principal.issuer ?? null,
        principal.subject ?? null,
        principal.clientId ?? null
      ])
    : undefined
}

function variantHints(params: Record<string, unknown>): McpVariantHints | undefined {
  const capabilities = isRecord(params.capabilities) ? params.capabilities : undefined
  const extensions = isRecord(capabilities?.extensions) ? capabilities.extensions : undefined
  const payload = isRecord(extensions?.[MCP_SERVER_VARIANTS_ID])
    ? extensions[MCP_SERVER_VARIANTS_ID]
    : undefined
  const hints = isRecord(payload?.variantHints) ? payload.variantHints : undefined
  if (!hints) return undefined
  if (hints.description !== undefined && typeof hints.description !== 'string')
    throw new JsonRpcError(-32602, 'Variant hints description must be a string')
  if (
    hints.hints !== undefined &&
    (!isRecord(hints.hints) ||
      Object.values(hints.hints).some(
        (value) =>
          typeof value !== 'string' &&
          (!Array.isArray(value) || value.some((item) => typeof item !== 'string'))
      ))
  )
    throw new JsonRpcError(-32602, 'Variant hints are invalid')
  return hints as McpVariantHints
}

async function rankVariants(
  visible: readonly McpServerVariant[],
  hints: McpVariantHints | undefined,
  context: McpInvocationContext,
  options: NormalizedMcpPluginOptions
): Promise<McpServerVariant[]> {
  const ids = await options.extensions.variants?.rank?.(visible, hints, context)
  if (!ids) {
    const requested = hints?.hints ?? {}
    return [...visible].sort(
      (left, right) =>
        variantScore(right, requested) - variantScore(left, requested) ||
        variantStatusRank(left) - variantStatusRank(right)
    )
  }
  const known = new Map(visible.map((variant) => [variant.id, variant]))
  if (new Set(ids).size !== ids.length || ids.some((id) => !known.has(id)))
    throw new TypeError('Variant rank callback returned invalid identifiers')
  return [
    ...ids.map((id) => known.get(id) as McpServerVariant),
    ...visible.filter((variant) => !ids.includes(variant.id))
  ]
}

function variantScore(variant: McpServerVariant, hints: Record<string, string | string[]>): number {
  let score = 0
  for (const [key, expected] of Object.entries(hints)) {
    const choices = Array.isArray(expected) ? expected : [expected]
    const index = choices.indexOf(variant.hints?.[key] ?? '')
    if (index >= 0) score += choices.length - index
  }
  return score
}

function variantStatusRank(variant: McpServerVariant): number {
  return (variant.status ?? 'stable') === 'stable' ? 0 : 1
}

function publicVariant(variant: McpServerVariant): Record<string, unknown> {
  const { tools: _tools, resources: _resources, prompts: _prompts, ...metadata } = variant
  return metadata
}

async function resolveActiveVariant(
  app: AnyElysiaApp,
  request: Request,
  params: Record<string, unknown>,
  options: NormalizedMcpPluginOptions,
  authorization?: McpAuthorizationContext
): Promise<{ variant: McpServerVariant; sessionId: string }> {
  const sessionId = request.headers.get('mcp-session-id')
  const session = sessionId ? variantSessions(app, options).get(sessionId) : undefined
  if (!session || session.principal !== variantPrincipal(authorization))
    throw new JsonRpcError(-32602, 'Unknown MCP session')
  const meta = isRecord(params._meta) ? params._meta : undefined
  const metadataSelector = meta?.[MCP_SERVER_VARIANT_META_KEY]
  const headerSelector = request.headers.get('mcp-server-variant')
  if (metadataSelector !== undefined && typeof metadataSelector !== 'string')
    throw new JsonRpcError(-32602, 'Invalid server variant')
  const requested =
    (metadataSelector as string | undefined) ?? headerSelector ?? session.variants[0]?.id
  const variant = session.variants.find((candidate) => candidate.id === requested)
  if (!variant)
    throw new JsonRpcError(-32602, 'Invalid server variant', {
      requestedVariant: requested,
      availableVariants: session.variants.map(({ id }) => id)
    })
  return { variant, sessionId: sessionId as string }
}

function variantAllows(
  variant: McpServerVariant | undefined,
  kind: 'tools' | 'resources' | 'prompts',
  identifier: string
): boolean {
  const allowed = variant?.[kind]
  return allowed === undefined || allowed.includes(identifier)
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
    !options.transport.allowedOrigins.includes(origin)
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

function createEmptySseResponse(): Response {
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(': connected\n\n'))
      controller.close()
    }
  })
  return new Response(body, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive'
    }
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

function isRequestId(value: unknown): value is string | number {
  return typeof value === 'string' || (typeof value === 'number' && Number.isInteger(value))
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
