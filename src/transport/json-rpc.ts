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
import { MCP_EXTENSION_SUPPORT } from '../extensions/manifest.js'
import {
  type DetailedTask,
  dispatchTaskRequest,
  hasTasksCapability,
  setTaskController,
  TaskController,
  TaskProtocolError
} from '../extensions/tasks/index.js'
import { isRecord } from '../internal.js'
import { findResourceReader, getMcpRegistry } from '../registry.js'
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
  McpProtocolError,
  type McpRequestProtocolContext,
  resolveRequestProtocol,
  serverDiscoverResult
} from './protocol.js'

const JSON_RPC_VERSION = '2.0' as const

interface DispatchContext {
  protocol: McpRequestProtocolContext
  authorization?: McpAuthorizationContext
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
      createErrorResponse(null, -32022, `Unsupported protocol version: ${protocolHeader}`, {
        supportedVersions: options.transport.protocolVersions
      }),
      400
    )
  }

  if (request.method === 'GET' || request.method === 'DELETE') {
    if (protocolHeader === MCP_EXTENSION_SUPPORT.protocol.current) {
      return jsonResponse(createErrorResponse(null, -32600, 'Modern MCP is POST-only'), 405)
    }
    return handleLegacyAuxiliaryMethod(request, options)
  }

  if (request.method !== 'POST') {
    return new Response(null, { status: 405, headers: { allow: 'POST, GET, DELETE' } })
  }

  const authorization = await authorizeRequest(request, options)
  if (authorization instanceof Response) return authorization

  let payload: unknown
  try {
    payload = await request.json()
  } catch (error) {
    return jsonResponse(
      createErrorResponse(
        null,
        -32700,
        'Parse error',
        error instanceof Error ? error.message : undefined
      ),
      400
    )
  }

  if (Array.isArray(payload)) {
    if (
      protocolHeader === MCP_EXTENSION_SUPPORT.protocol.current ||
      payload.some(
        (item) =>
          isRecord(item) &&
          isRecord(item.params) &&
          isRecord(item.params._meta) &&
          item.params._meta['io.modelcontextprotocol/protocolVersion'] ===
            MCP_EXTENSION_SUPPORT.protocol.current
      )
    ) {
      return jsonResponse(
        createErrorResponse(null, -32600, 'Modern MCP does not support batches'),
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
    return handleTaskSubscription(
      app,
      payload as unknown as JsonRpcRequest,
      request,
      options,
      authorization
    )
  }

  const outcome = await handleJsonRpcMessage(app, payload, request, options, authorization)
  if (!outcome.response) return new Response(null, { status: 202 })
  const responseHeaders: HeadersInit =
    outcome.status === 403 && options.extensions.auth
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
      : {}
  return jsonResponse(outcome.response, outcome.status, responseHeaders)
}

async function handleJsonRpcMessage(
  app: AnyElysiaApp,
  payload: unknown,
  request: Request,
  options: NormalizedMcpPluginOptions,
  authorization?: McpAuthorizationContext
): Promise<RpcOutcome> {
  if (!isJsonRpcRequest(payload)) {
    return { response: createErrorResponse(null, -32600, 'Invalid Request'), status: 400 }
  }

  const id = payload.id ?? null

  try {
    const protocol = resolveRequestProtocol(request, payload, options)
    if (payload.id === undefined || payload.id === null) return { status: 202 }
    const result = await dispatchRequest(app, payload, request, options, {
      protocol,
      authorization
    })
    return {
      response: { jsonrpc: JSON_RPC_VERSION, id, result },
      status: 200
    }
  } catch (error) {
    return {
      response: normalizeDispatchError(id, error),
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

  const extensionResult = await extensionDispatcher(options, context).dispatch(method, {
    request,
    params
  })
  if (extensionResult.handled) return extensionResult.result

  switch (method) {
    case 'initialize':
      if (context.protocol.modern)
        throw new JsonRpcError(-32601, 'Method not found: initialize', undefined, 404)
      return initializeResult(options)
    case 'server/discover':
      if (!context.protocol.modern) {
        throw new JsonRpcError(-32601, 'Method not found: server/discover', undefined, 404)
      }
      return modernDiscoverResult(options)
    case 'ping':
      if (context.protocol.modern) {
        throw new JsonRpcError(-32601, 'Method not found: ping', undefined, 404)
      }
      return {}
    case 'tools/list':
      return listTools(app, options, context)
    case 'tools/call':
      return callTool(app, params, request, options, context)
    case 'resources/list':
      return listResources(app, options, context)
    case 'resources/templates/list':
      return listResourceTemplates(app, options, context)
    case 'resources/read':
      return readResource(app, params, request, options, context)
    case 'prompts/list':
      return listPrompts(app, options, context)
    case 'prompts/get':
      return getPrompt(app, params, request, options, context)
    default:
      throw new JsonRpcError(
        -32601,
        `Method not found: ${method}`,
        undefined,
        context.protocol.modern ? 404 : 200
      )
  }
}

function initializeResult(options: NormalizedMcpPluginOptions): Record<string, unknown> {
  const extensions: Record<string, unknown> = {}
  if (options.extensions.apps?.version === '2026-01-26') {
    extensions[MCP_APPS_EXTENSION_ID] = { version: options.extensions.apps.version }
  }

  return {
    protocolVersion: options.transport.protocolVersion,
    capabilities: {
      tools: { listChanged: false },
      resources: { subscribe: false, listChanged: false },
      prompts: { listChanged: false },
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

function modernDiscoverResult(options: NormalizedMcpPluginOptions): Record<string, unknown> {
  const result = serverDiscoverResult(options)
  const extensions: Record<string, unknown> = {}
  if (options.extensions.tasks) {
    extensions['io.modelcontextprotocol/tasks'] = { version: options.extensions.tasks.version }
  }
  if (options.extensions.apps) {
    extensions[MCP_APPS_EXTENSION_ID] = { version: options.extensions.apps.version }
  }
  if (options.extensions.auth) {
    Object.assign(extensions, authProfileCapabilities(options.extensions.auth.profiles))
  }
  return {
    ...result,
    capabilities: {
      ...result.capabilities,
      extensions
    }
  }
}

function listTools(
  app: AnyElysiaApp,
  options: NormalizedMcpPluginOptions,
  context: DispatchContext
): Record<string, unknown> {
  const registry = getMcpRegistry(app, options)
  validateAppReferences(registry.tools.values(), registry.resources, options)
  const tools = Array.from(registry.tools.values())
    .filter((tool) => isAuthorized(tool.authorization, context.authorization))
    .filter((tool) => isToolVisible(tool, context))
    .map((tool) => serializeTool(tool, options))
  return { tools }
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
  if (!tool) throw new JsonRpcError(-32602, `Unknown tool: ${name}`)
  enforceAuthorization(tool.authorization, context.authorization, options)

  const args = 'arguments' in params ? params.arguments : {}
  const invocation = invocationContext(request, params, context)
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
        invoke: async () =>
          (await tool.invoke(args, invocation)) as unknown as Record<string, unknown>
      }
    },
    taskRequestContext(request, params, context)
  )
}

function listResources(
  app: AnyElysiaApp,
  options: NormalizedMcpPluginOptions,
  context: DispatchContext
): Record<string, unknown> {
  const registry = getMcpRegistry(app, options)
  return {
    resources: Array.from(registry.resources.values())
      .filter((resource) => isAuthorized(resource.authorization, context.authorization))
      .map((resource) => serializeResource(resource, options))
  }
}

function listResourceTemplates(
  app: AnyElysiaApp,
  options: NormalizedMcpPluginOptions,
  context: DispatchContext
): Record<string, unknown> {
  const registry = getMcpRegistry(app, options)
  return {
    resourceTemplates: Array.from(registry.resourceTemplates.values())
      .filter((template) => isAuthorized(template.authorization, context.authorization))
      .map((template) => serializeResourceTemplate(template, options))
  }
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
  const reader = findResourceReader(getMcpRegistry(app, options), uri)
  if (!reader) throw new JsonRpcError(-32002, `Resource not found: ${uri}`, { uri })
  enforceAuthorization(reader.definition.authorization, context.authorization, options)
  const result = await reader.definition.read({
    ...invocationContext(request, params, context),
    uri,
    variables: reader.variables
  })

  if (options.extensions.apps && uri.startsWith('ui://')) {
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
  options: NormalizedMcpPluginOptions,
  context: DispatchContext
): Record<string, unknown> {
  return {
    prompts: Array.from(getMcpRegistry(app, options).prompts.values())
      .filter((prompt) => isAuthorized(prompt.authorization, context.authorization))
      .map(serializePrompt)
  }
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
  if (!prompt) throw new JsonRpcError(-32602, `Invalid prompt name: ${name}`)
  enforceAuthorization(prompt.authorization, context.authorization, options)
  const args = isRecord(params.arguments) ? params.arguments : {}
  return prompt.get(args, {
    ...invocationContext(request, params, context),
    name
  })
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

function invocationContext(
  request: Request,
  params: Record<string, unknown>,
  context: DispatchContext
): McpInvocationContext {
  return {
    request,
    signal: request.signal,
    meta: isRecord(params._meta) ? params._meta : undefined,
    protocolVersion: context.protocol.version,
    clientCapabilities: context.protocol.clientCapabilities,
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
    signal: request.signal,
    meta: isRecord(params._meta) ? params._meta : undefined,
    principalKey: principal
      ? `${principal.issuer ?? ''}\u0000${principal.subject ?? ''}\u0000${principal.clientId ?? ''}`
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

async function handleTaskSubscription(
  app: AnyElysiaApp,
  payload: JsonRpcRequest,
  request: Request,
  options: NormalizedMcpPluginOptions,
  authorization?: McpAuthorizationContext
): Promise<Response> {
  if (!isJsonRpcRequest(payload) || payload.id === undefined || payload.id === null) {
    return jsonResponse(createErrorResponse(null, -32600, 'Invalid Request'), 400)
  }
  try {
    const protocol = resolveRequestProtocol(request, payload, options)
    const context = { protocol, authorization }
    assertModernTasks(context, options)
    const params = isRecord(payload.params) ? payload.params : {}
    const meta = isRecord(params._meta) ? params._meta : undefined
    const controller = taskController(options)
    controller.assertClientCapability(meta)
    const taskIds = Array.isArray(params.taskIds)
      ? params.taskIds.filter((value): value is string => typeof value === 'string')
      : []
    const subscriptionId = crypto.randomUUID()
    const encoder = new TextEncoder()
    let subscription: { close(): void | Promise<void> } | undefined
    const body = new ReadableStream<Uint8Array>({
      async start(stream) {
        stream.enqueue(
          encoder.encode(
            `event: message\ndata: ${JSON.stringify({
              jsonrpc: JSON_RPC_VERSION,
              id: payload.id,
              result: { resultType: 'complete', subscriptionId }
            })}\n\n`
          )
        )
        subscription = await controller.listen(
          taskIds,
          (task: DetailedTask) => {
            stream.enqueue(
              encoder.encode(
                `event: message\ndata: ${JSON.stringify({
                  jsonrpc: JSON_RPC_VERSION,
                  method: 'notifications/tasks',
                  params: { subscriptionId, task }
                })}\n\n`
              )
            )
          },
          taskRequestContext(request, params, context)
        )
      },
      async cancel() {
        await subscription?.close()
      }
    })
    void app
    return new Response(body, {
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive'
      }
    })
  } catch (error) {
    return jsonResponse(normalizeDispatchError(payload.id ?? null, error), errorStatus(error))
  }
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
  const extensions = context.protocol.clientCapabilities.extensions
  return isRecord(extensions) && isRecord(extensions[MCP_APPS_EXTENSION_ID])
}

function normalizeDispatchError(id: string | number | null, error: unknown): JsonRpcResponse {
  if (
    error instanceof JsonRpcError ||
    error instanceof McpProtocolError ||
    error instanceof TaskProtocolError
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
  if (error instanceof JsonRpcError || error instanceof McpProtocolError) return error.status
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

function handleLegacyAuxiliaryMethod(
  request: Request,
  options: NormalizedMcpPluginOptions
): Response {
  if (request.method === 'GET') {
    if (!options.transport.enableGetSse) {
      return new Response(null, { status: 405, headers: { allow: 'POST, GET, DELETE' } })
    }
    return createEmptySseResponse()
  }
  if (!options.transport.enableDeleteSession) {
    return new Response(null, { status: 405, headers: { allow: 'POST, GET, DELETE' } })
  }
  return new Response(null, { status: 202 })
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
    return jsonResponse(createErrorResponse(null, -32000, 'Forbidden origin'), 403)
  }
  return undefined
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

function jsonResponse(body: unknown, status = 200, extraHeaders: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...extraHeaders }
  })
}

function createErrorResponse(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown
): JsonRpcResponse {
  return {
    jsonrpc: JSON_RPC_VERSION,
    id,
    error: pruneUndefined({ code, message, data }) as JsonRpcResponse['error']
  }
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
