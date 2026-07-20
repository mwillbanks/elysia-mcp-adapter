import { isRecord } from '../internal.js'
import { findResourceReader, getMcpRegistry } from '../registry.js'
import type {
  AnyElysiaApp,
  JsonRpcRequest,
  JsonRpcResponse,
  McpPromptDefinition,
  McpResourceDefinition,
  McpResourceTemplateDefinition,
  McpToolDefinition,
  NormalizedMcpPluginOptions
} from '../types.js'

const JSON_RPC_VERSION = '2.0' as const

export async function handleMcpHttpRequest(
  app: AnyElysiaApp,
  request: Request,
  options: NormalizedMcpPluginOptions
): Promise<Response> {
  const originValidation = validateOrigin(request, options)
  if (originValidation) return originValidation

  if (request.method === 'GET') {
    if (!options.transport.enableGetSse) {
      return new Response(null, {
        status: 405,
        headers: {
          allow: 'POST, GET, DELETE'
        }
      })
    }

    return createEmptySseResponse()
  }

  if (request.method === 'DELETE') {
    if (!options.transport.enableDeleteSession) {
      return new Response(null, {
        status: 405,
        headers: { allow: 'POST, GET, DELETE' }
      })
    }

    return new Response(null, { status: 202 })
  }

  if (request.method !== 'POST') {
    return new Response(null, {
      status: 405,
      headers: { allow: 'POST, GET, DELETE' }
    })
  }

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
    const responses: JsonRpcResponse[] = []

    for (const item of payload) {
      const response = await handleJsonRpcMessage(app, item, request, options)
      if (response) responses.push(response)
    }

    if (responses.length === 0) return new Response(null, { status: 202 })
    return jsonResponse(responses)
  }

  const response = await handleJsonRpcMessage(app, payload, request, options)
  if (!response) return new Response(null, { status: 202 })

  return jsonResponse(response)
}

async function handleJsonRpcMessage(
  app: AnyElysiaApp,
  payload: unknown,
  request: Request,
  options: NormalizedMcpPluginOptions
): Promise<JsonRpcResponse | undefined> {
  if (!isJsonRpcRequest(payload)) {
    return createErrorResponse(null, -32600, 'Invalid Request')
  }

  const id = payload.id ?? null

  if (!payload.method) {
    // JSON-RPC responses from clients are accepted and do not produce a response.
    return undefined
  }

  if (payload.id === undefined || payload.id === null) {
    // Notifications and client responses do not receive a reply.
    return undefined
  }

  try {
    const result = await dispatchRequest(app, payload, request, options)
    return {
      jsonrpc: JSON_RPC_VERSION,
      id,
      result
    }
  } catch (error) {
    return normalizeDispatchError(id, error)
  }
}

async function dispatchRequest(
  app: AnyElysiaApp,
  payload: JsonRpcRequest,
  request: Request,
  options: NormalizedMcpPluginOptions
): Promise<unknown> {
  const method = payload.method
  const params = isRecord(payload.params) ? payload.params : {}

  switch (method) {
    case 'initialize':
      return initializeResult(options)

    case 'ping':
      return {}

    case 'tools/list':
      return listTools(app, options)

    case 'tools/call':
      return callTool(app, params, request, options)

    case 'resources/list':
      return listResources(app, options)

    case 'resources/templates/list':
      return listResourceTemplates(app, options)

    case 'resources/read':
      return readResource(app, params, request, options)

    case 'prompts/list':
      return listPrompts(app, options)

    case 'prompts/get':
      return getPrompt(app, params, request, options)

    default:
      throw new JsonRpcError(-32601, `Method not found: ${method}`)
  }
}

function initializeResult(options: NormalizedMcpPluginOptions): Record<string, unknown> {
  return {
    protocolVersion: options.transport.protocolVersion,
    capabilities: {
      tools: { listChanged: false },
      resources: { subscribe: false, listChanged: false },
      prompts: { listChanged: false }
    },
    serverInfo: {
      name: options.server.name,
      version: options.server.version,
      title: options.server.title
    },
    instructions: options.server.instructions
  }
}

function listTools(
  app: AnyElysiaApp,
  options: NormalizedMcpPluginOptions
): Record<string, unknown> {
  const registry = getMcpRegistry(app, options)

  return {
    tools: Array.from(registry.tools.values()).map(serializeTool)
  }
}

async function callTool(
  app: AnyElysiaApp,
  params: Record<string, unknown>,
  request: Request,
  options: NormalizedMcpPluginOptions
): Promise<unknown> {
  const name = params.name
  if (typeof name !== 'string') throw new JsonRpcError(-32602, 'Missing tool name')

  const registry = getMcpRegistry(app, options)
  const tool = registry.tools.get(name)
  if (!tool) throw new JsonRpcError(-32602, `Unknown tool: ${name}`)

  const args = 'arguments' in params ? params.arguments : {}

  return tool.invoke(args, {
    request,
    meta: isRecord(params._meta) ? params._meta : undefined
  })
}

function listResources(
  app: AnyElysiaApp,
  options: NormalizedMcpPluginOptions
): Record<string, unknown> {
  const registry = getMcpRegistry(app, options)

  return {
    resources: Array.from(registry.resources.values()).map(serializeResource)
  }
}

function listResourceTemplates(
  app: AnyElysiaApp,
  options: NormalizedMcpPluginOptions
): Record<string, unknown> {
  const registry = getMcpRegistry(app, options)

  return {
    resourceTemplates: Array.from(registry.resourceTemplates.values()).map(
      serializeResourceTemplate
    )
  }
}

async function readResource(
  app: AnyElysiaApp,
  params: Record<string, unknown>,
  request: Request,
  options: NormalizedMcpPluginOptions
): Promise<unknown> {
  const uri = params.uri
  if (typeof uri !== 'string') throw new JsonRpcError(-32602, 'Missing resource uri')

  const registry = getMcpRegistry(app, options)
  const reader = findResourceReader(registry, uri)

  if (!reader) throw new JsonRpcError(-32002, `Resource not found: ${uri}`, { uri })

  return reader.definition.read({
    request,
    uri,
    variables: reader.variables,
    meta: isRecord(params._meta) ? params._meta : undefined
  })
}

function listPrompts(
  app: AnyElysiaApp,
  options: NormalizedMcpPluginOptions
): Record<string, unknown> {
  const registry = getMcpRegistry(app, options)

  return {
    prompts: Array.from(registry.prompts.values()).map(serializePrompt)
  }
}

async function getPrompt(
  app: AnyElysiaApp,
  params: Record<string, unknown>,
  request: Request,
  options: NormalizedMcpPluginOptions
): Promise<unknown> {
  const name = params.name
  if (typeof name !== 'string') throw new JsonRpcError(-32602, 'Missing prompt name')

  const registry = getMcpRegistry(app, options)
  const prompt = registry.prompts.get(name)
  if (!prompt) throw new JsonRpcError(-32602, `Invalid prompt name: ${name}`)

  const args = isRecord(params.arguments) ? params.arguments : {}

  return prompt.get(args, {
    request,
    name,
    meta: isRecord(params._meta) ? params._meta : undefined
  })
}

function serializeTool(tool: McpToolDefinition): Record<string, unknown> {
  return pruneUndefined({
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema,
    annotations: tool.annotations,
    icons: tool.icons
  })
}

function serializeResource(resource: McpResourceDefinition): Record<string, unknown> {
  return pruneUndefined({
    uri: resource.uri,
    name: resource.name,
    title: resource.title,
    description: resource.description,
    mimeType: resource.mimeType,
    annotations: resource.annotations,
    icons: resource.icons
  })
}

function serializeResourceTemplate(
  template: McpResourceTemplateDefinition
): Record<string, unknown> {
  return pruneUndefined({
    uriTemplate: template.uriTemplate,
    name: template.name,
    title: template.title,
    description: template.description,
    mimeType: template.mimeType,
    annotations: template.annotations,
    icons: template.icons
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

function normalizeDispatchError(id: string | number | null, error: unknown): JsonRpcResponse {
  if (error instanceof JsonRpcError) {
    return createErrorResponse(id, error.code, error.message, error.data)
  }

  return createErrorResponse(id, -32603, error instanceof Error ? error.message : 'Internal error')
}

function validateOrigin(
  request: Request,
  options: NormalizedMcpPluginOptions
): Response | undefined {
  if (!options.transport.validateOrigin) return undefined

  const origin = request.headers.get('origin')
  if (!origin) return undefined

  if (options.transport.allowedOrigins.length === 0) {
    // Default-deny browser-originated requests. Non-browser MCP clients do not send Origin.
    return jsonResponse(createErrorResponse(null, -32000, 'Forbidden origin'), 403)
  }

  if (!options.transport.allowedOrigins.includes(origin)) {
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
    status: 200,
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive'
    }
  })
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json'
    }
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
  return isRecord(value) && value.jsonrpc === JSON_RPC_VERSION
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
    readonly data?: unknown
  ) {
    super(message)
  }
}
