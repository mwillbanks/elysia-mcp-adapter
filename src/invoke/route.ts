import { validateJsonSchema } from '../schema/validate.js'
import type {
  JsonSchema,
  McpHandlerContext,
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
import { deleteMcpInvocationContext, withInvocationHelpers } from './context.js'
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
  return invokeRoute(operation, input, withInvocationHelpers(context), options, (response) =>
    marshalHttpResponseToToolResult(
      response,
      `${operation.method} ${operation.path}`,
      options,
      operation.mcp === false ? undefined : operation.mcp?.marshal
    )
  )
}

export async function invokeRouteResource(
  operation: McpRouteOperation,
  context: McpResourceInvocationContext,
  options: NormalizedMcpPluginOptions
): Promise<McpResourceHandlerResult> {
  const routeMcp = operation.mcp === false ? undefined : operation.mcp
  const mapper = routeMcp?.resource?.mapUriToInput
  const invocation = withInvocationHelpers(context)
  const input = mapper
    ? mapper(context.variables, invocation)
    : defaultResourceInput(operation, context.variables)

  return invokeRoute(operation, input, invocation, options, (response) =>
    marshalHttpResponseToResourceResult(response, context.uri, options, routeMcp?.marshal)
  )
}

export async function invokeRoutePrompt(
  operation: McpRouteOperation,
  args: Record<string, unknown>,
  context: McpPromptInvocationContext,
  options: NormalizedMcpPluginOptions
): Promise<McpPromptHandlerResult> {
  const routeMcp = operation.mcp === false ? undefined : operation.mcp
  const mapper = routeMcp?.prompt?.mapArgsToInput
  const invocation = withInvocationHelpers(context)
  const input = mapper ? mapper(args, invocation) : defaultPromptInput(operation, args)

  return invokeRoute(operation, input, invocation, options, (response) =>
    marshalHttpResponseToPromptResult(response, options, routeMcp?.marshal)
  )
}

async function invokeRoute<Result>(
  operation: McpRouteOperation,
  input: RouteInvocationInput,
  context: McpHandlerContext,
  options: NormalizedMcpPluginOptions,
  marshal: (response: Response) => Promise<Result>
): Promise<Result> {
  const request = buildInternalRequest(operation, input, context, options)
  try {
    const response = await operation.app.handle(request)
    return await marshal(response)
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
