import { validateJsonSchema } from '../schema/validate.js'
import type {
  JsonSchema,
  McpInvocationContext,
  McpPromptHandlerResult,
  McpPromptInvocationContext,
  McpResourceHandlerResult,
  McpResourceInvocationContext,
  McpRouteOperation,
  McpToolHandlerResult,
  NormalizedMcpPluginOptions,
  RouteInvocationInput
} from '../types.js'
import { buildInternalRequest, normalizeRouteToolInput } from './build-request.js'
import { deleteMcpInvocationContext } from './context.js'
import {
  createValidationToolError,
  marshalHttpResponseToPromptResult,
  marshalHttpResponseToResourceResult,
  marshalHttpResponseToToolResult
} from './marshal-response.js'

export async function invokeRouteTool(
  operation: McpRouteOperation,
  args: unknown,
  inputSchema: JsonSchema,
  context: McpInvocationContext,
  options: NormalizedMcpPluginOptions
): Promise<McpToolHandlerResult> {
  const validation = validateJsonSchema(inputSchema, args ?? {})
  if (!validation.ok) return createValidationToolError(validation.issues)

  const input = normalizeRouteToolInput(args ?? {}, operation, options)
  const request = buildInternalRequest(operation, input, context, options)
  try {
    const response = await operation.app.handle(request)
    return marshalHttpResponseToToolResult(
      response,
      `${operation.method} ${operation.path}`,
      options,
      operation.mcp === false ? undefined : operation.mcp?.marshal
    )
  } finally {
    deleteMcpInvocationContext(request)
  }
}

export async function invokeRouteResource(
  operation: McpRouteOperation,
  context: McpResourceInvocationContext,
  options: NormalizedMcpPluginOptions
): Promise<McpResourceHandlerResult> {
  const routeMcp = operation.mcp === false ? undefined : operation.mcp
  const mapper = routeMcp?.resource?.mapUriToInput

  const input = mapper
    ? mapper(context.variables, context)
    : defaultResourceInput(operation, context.variables)

  const request = buildInternalRequest(operation, input, context, options)
  try {
    const response = await operation.app.handle(request)
    return marshalHttpResponseToResourceResult(response, context.uri, options, routeMcp?.marshal)
  } finally {
    deleteMcpInvocationContext(request)
  }
}

export async function invokeRoutePrompt(
  operation: McpRouteOperation,
  args: Record<string, unknown>,
  context: McpPromptInvocationContext,
  options: NormalizedMcpPluginOptions
): Promise<McpPromptHandlerResult> {
  const routeMcp = operation.mcp === false ? undefined : operation.mcp
  const mapper = routeMcp?.prompt?.mapArgsToInput

  const input = mapper ? mapper(args, context) : defaultPromptInput(operation, args)
  const request = buildInternalRequest(operation, input, context, options)
  try {
    const response = await operation.app.handle(request)
    return marshalHttpResponseToPromptResult(response, options, routeMcp?.marshal)
  } finally {
    deleteMcpInvocationContext(request)
  }
}

function defaultResourceInput(
  operation: McpRouteOperation,
  variables: Record<string, string>
): RouteInvocationInput {
  const params: Record<string, unknown> = {}
  const query: Record<string, unknown> = {}
  const routeParamNames = operation.path
    .split('/')
    .filter((part) => part.startsWith(':'))
    .map((part) => part.slice(1))

  for (const [key, value] of Object.entries(variables)) {
    if (routeParamNames.includes(key)) params[key] = value
    else query[key] = value
  }

  return {
    params: Object.keys(params).length ? params : undefined,
    query: Object.keys(query).length ? query : undefined
  }
}

function defaultPromptInput(
  operation: McpRouteOperation,
  args: Record<string, unknown>
): RouteInvocationInput {
  if (operation.method === 'GET') return { query: args }
  return { body: args }
}
