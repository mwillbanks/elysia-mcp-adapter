import {
  coercePromptResult,
  coerceResourceResult,
  coerceToolResult,
  createValidationToolError
} from './invoke/marshal-response.js'
import { invokeRoutePrompt, invokeRouteResource, invokeRouteTool } from './invoke/route.js'
import { humanizeOperationName, sanitizeMcpName } from './naming.js'
import { isUriTemplate, matchUriTemplate, templateName } from './resource-template.js'
import { shouldExposeRoute } from './route-filters.js'
import { listRouteOperations, routeFingerprint } from './route-inspector.js'
import {
  composeExplicitInputSchema,
  composeExplicitOutputSchema,
  composeRouteInputSchema,
  composeRouteOutputSchema,
  promptArgumentsFromSchema
} from './schema/compose.js'
import { validateJsonSchema } from './schema/validate.js'
import { ensureMcpState } from './state.js'
import type {
  AnyElysiaApp,
  ExplicitPromptRegistration,
  ExplicitResourceRegistration,
  ExplicitToolRegistration,
  JsonSchema,
  McpPromptDefinition,
  McpRegistry,
  McpResourceDefinition,
  McpResourceTemplateDefinition,
  McpRouteKind,
  McpRouteOperation,
  McpToolDefinition,
  NormalizedMcpPluginOptions
} from './types.js'

export function getMcpRegistry(
  app: AnyElysiaApp,
  options: NormalizedMcpPluginOptions
): McpRegistry {
  const state = ensureMcpState(app)
  const fingerprint = routeFingerprint(app)

  if (
    state.registryCache &&
    state.registryCache.version === state.version &&
    state.registryCache.fingerprint === fingerprint
  ) {
    return state.registryCache.registry
  }

  const registry = buildMcpRegistry(app, options)
  state.registryCache = {
    fingerprint,
    version: state.version,
    registry
  }

  return registry
}

function buildMcpRegistry(app: AnyElysiaApp, options: NormalizedMcpPluginOptions): McpRegistry {
  const state = ensureMcpState(app)
  const registry: McpRegistry = {
    tools: new Map(),
    resources: new Map(),
    resourceTemplates: new Map(),
    prompts: new Map()
  }

  for (const tool of state.explicitTools.values()) {
    addTool(registry, createExplicitTool(tool, options), options)
  }

  for (const resource of state.explicitResources.values()) {
    const definition = createExplicitResource(resource, options)
    if ('uriTemplate' in definition) addResourceTemplate(registry, definition, options)
    else addResource(registry, definition, options)
  }

  for (const prompt of state.explicitPrompts.values()) {
    addPrompt(registry, createExplicitPrompt(prompt, options), options)
  }

  const routeOperations = listRouteOperations(app)

  for (const operation of routeOperations) {
    if (!shouldExposeRoute(operation, options)) continue

    const kind = resolveRouteKind(operation, options)

    if (kind === 'tool') {
      addTool(registry, createRouteTool(operation, options), options)
    } else if (kind === 'resource') {
      const definition = createRouteResource(operation, options)
      if (definition) {
        if ('uriTemplate' in definition) addResourceTemplate(registry, definition, options)
        else addResource(registry, definition, options)
      }
    } else if (kind === 'prompt') {
      addPrompt(registry, createRoutePrompt(operation, options), options)
    }
  }

  return registry
}

function createExplicitTool(
  registration: ExplicitToolRegistration,
  options: NormalizedMcpPluginOptions
): McpToolDefinition {
  const inputSchema = composeExplicitInputSchema(registration.options.inputSchema, 'tool', options)
  const outputSchema = composeExplicitOutputSchema(
    registration.options.outputSchema,
    'tool',
    options
  )

  return {
    source: 'explicit',
    name: sanitizeMcpName(registration.name),
    title: registration.options.title,
    description: registration.options.description,
    inputSchema,
    outputSchema,
    annotations: registration.options.annotations,
    icons: registration.options.icons,
    authorization: registration.options.authorization,
    taskExecution: registration.options.taskExecution ?? 'optional',
    app: registration.options.app,
    invoke: async (args, context) => {
      const validation = validateJsonSchema(inputSchema, args ?? {})
      if (!validation.ok) return createValidationToolError(validation.issues)

      const result = await registration.handler(args ?? {}, context)
      return coerceToolResult(result)
    }
  }
}

function createExplicitResource(
  registration: ExplicitResourceRegistration,
  _options: NormalizedMcpPluginOptions
): McpResourceDefinition | McpResourceTemplateDefinition {
  const name = sanitizeMcpName(
    registration.options.name ?? templateName(registration.uriOrTemplate)
  )
  const base = {
    source: 'explicit' as const,
    name,
    title: registration.options.title,
    description: registration.options.description,
    mimeType: registration.options.mimeType,
    annotations: registration.options.annotations,
    icons: registration.options.icons,
    authorization: registration.options.authorization,
    app: registration.options.app,
    read: async (context: any) => {
      const result = await registration.handler(context)
      return coerceResourceResult(result, context.uri, registration.options.mimeType)
    }
  }

  if (isUriTemplate(registration.uriOrTemplate)) {
    return {
      ...base,
      uriTemplate: registration.uriOrTemplate
    }
  }

  return {
    ...base,
    uri: registration.uriOrTemplate
  }
}

function createExplicitPrompt(
  registration: ExplicitPromptRegistration,
  options: NormalizedMcpPluginOptions
): McpPromptDefinition {
  const argsSchema = composeExplicitInputSchema(registration.options.argsSchema, 'prompt', options)
  const promptArguments = registration.options.arguments ?? promptArgumentsFromSchema(argsSchema)

  return {
    source: 'explicit',
    name: sanitizeMcpName(registration.name),
    title: registration.options.title,
    description: registration.options.description,
    argsSchema,
    arguments: promptArguments,
    icons: registration.options.icons,
    authorization: registration.options.authorization,
    get: async (args, context) => {
      assertValidPromptArgs(argsSchema, args ?? {})
      const result = await registration.handler(args ?? {}, context)
      return coercePromptResult(result)
    }
  }
}

function createRouteTool(
  operation: McpRouteOperation,
  options: NormalizedMcpPluginOptions
): McpToolDefinition {
  const routeMcp = operation.mcp === false ? undefined : operation.mcp
  const inputSchema = composeRouteInputSchema(operation, 'tool', options)
  const outputSchema = composeRouteOutputSchema(operation, 'tool', options)
  const name = sanitizeMcpName(routeMcp?.name ?? options.operationNameResolver(operation))

  if (
    options.diagnostics.failOnMissingSchema &&
    !routeMcp?.inputSchema &&
    !hasRouteInputSchema(operation)
  ) {
    throw new Error(`Missing input schema for MCP route tool ${operation.method} ${operation.path}`)
  }

  return {
    source: 'route',
    name,
    title: routeTitle(operation, name, routeMcp?.title),
    description: routeDescription(
      operation,
      routeMcp?.description,
      `${operation.method} ${operation.path}`
    ),
    inputSchema,
    outputSchema,
    annotations: routeMcp?.annotations ?? defaultAnnotationsForMethod(operation.method),
    icons: routeMcp?.icons,
    authorization: routeMcp?.authorization,
    taskExecution: routeMcp?.taskExecution ?? 'optional',
    app: routeMcp?.app,
    invoke: (args, context) => invokeRouteTool(operation, args ?? {}, inputSchema, context, options)
  }
}

function createRouteResource(
  operation: McpRouteOperation,
  options: NormalizedMcpPluginOptions
): McpResourceDefinition | McpResourceTemplateDefinition | undefined {
  const routeMcp = operation.mcp === false ? undefined : operation.mcp
  const resource = routeMcp?.resource

  if (!resource?.uri && !resource?.uriTemplate) return undefined

  const uriOrTemplate = resource.uriTemplate ?? resource.uri
  if (!uriOrTemplate) return undefined

  const name = sanitizeMcpName(routeMcp?.name ?? resource.name ?? templateName(uriOrTemplate))
  const base = {
    source: 'route' as const,
    name,
    title: routeTitle(operation, name, resource.title ?? routeMcp?.title),
    description: routeDescription(operation, resource.description ?? routeMcp?.description),
    mimeType: resource.mimeType,
    annotations: resource.annotations,
    icons: routeMcp?.icons,
    authorization: resource.authorization ?? routeMcp?.authorization,
    app: resource.app,
    read: (context: any) => invokeRouteResource(operation, context, options)
  }

  if (resource.uriTemplate) {
    return {
      ...base,
      uriTemplate: resource.uriTemplate
    }
  }

  return {
    ...base,
    uri: uriOrTemplate
  }
}

function createRoutePrompt(
  operation: McpRouteOperation,
  options: NormalizedMcpPluginOptions
): McpPromptDefinition {
  const routeMcp = operation.mcp === false ? undefined : operation.mcp
  const argsSchema = composeRouteInputSchema(operation, 'prompt', options)
  const name = sanitizeMcpName(routeMcp?.name ?? options.operationNameResolver(operation))

  return {
    source: 'route',
    name,
    title: routeTitle(operation, name, routeMcp?.title),
    description: routeDescription(operation, routeMcp?.description),
    argsSchema,
    arguments: routeMcp?.prompt?.arguments ?? promptArgumentsFromSchema(argsSchema),
    icons: routeMcp?.icons,
    authorization: routeMcp?.authorization,
    get: async (args, context) => {
      assertValidPromptArgs(argsSchema, args ?? {})
      return invokeRoutePrompt(operation, args ?? {}, context, options)
    }
  }
}

export function findResourceReader(
  registry: McpRegistry,
  uri: string
):
  | { type: 'resource'; definition: McpResourceDefinition; variables: Record<string, string> }
  | {
      type: 'template'
      definition: McpResourceTemplateDefinition
      variables: Record<string, string>
    }
  | undefined {
  const resource = registry.resources.get(uri)
  if (resource) return { type: 'resource', definition: resource, variables: {} }

  for (const template of registry.resourceTemplates.values()) {
    const match = matchUriTemplate(template.uriTemplate, uri)
    if (match.ok) return { type: 'template', definition: template, variables: match.variables }
  }

  return undefined
}

function resolveRouteKind(
  operation: McpRouteOperation,
  options: NormalizedMcpPluginOptions
): McpRouteKind {
  const routeMcp = operation.mcp === false ? undefined : operation.mcp
  return routeMcp?.kind ?? options.defaultRouteKind
}

function addTool(
  registry: McpRegistry,
  tool: McpToolDefinition,
  options: NormalizedMcpPluginOptions
): void {
  const name = uniqueName(tool.name, registry.tools, options)
  registry.tools.set(name, name === tool.name ? tool : { ...tool, name })
}

function addResource(
  registry: McpRegistry,
  resource: McpResourceDefinition,
  options: NormalizedMcpPluginOptions
): void {
  const name = uniqueName(resource.uri, registry.resources, options)
  registry.resources.set(name, name === resource.uri ? resource : { ...resource, uri: name })
}

function addResourceTemplate(
  registry: McpRegistry,
  template: McpResourceTemplateDefinition,
  options: NormalizedMcpPluginOptions
): void {
  const name = uniqueName(template.uriTemplate, registry.resourceTemplates, options)
  registry.resourceTemplates.set(
    name,
    name === template.uriTemplate ? template : { ...template, uriTemplate: name }
  )
}

function addPrompt(
  registry: McpRegistry,
  prompt: McpPromptDefinition,
  options: NormalizedMcpPluginOptions
): void {
  const name = uniqueName(prompt.name, registry.prompts, options)
  registry.prompts.set(name, name === prompt.name ? prompt : { ...prompt, name })
}

function uniqueName<T>(
  name: string,
  map: Map<string, T>,
  options: NormalizedMcpPluginOptions
): string {
  if (!map.has(name)) return name

  if (options.onNameCollision === 'error') {
    throw new Error(`Duplicate MCP name: ${name}`)
  }

  for (let index = 2; index < 10_000; index += 1) {
    const candidate = `${name}_${index}`
    if (!map.has(candidate)) return candidate
  }

  throw new Error(`Unable to generate unique MCP name for: ${name}`)
}

function assertValidPromptArgs(argsSchema: JsonSchema, args: Record<string, unknown>): void {
  const validation = validateJsonSchema(argsSchema, args)
  if (!validation.ok) {
    throw new Error(`Invalid prompt arguments: ${JSON.stringify(validation.issues)}`)
  }
}

function routeTitle(operation: McpRouteOperation, name: string, override?: string): string {
  return override ?? stringDetail(operation, 'summary') ?? humanizeOperationName(name)
}

function routeDescription(
  operation: McpRouteOperation,
  override?: string,
  fallback?: string
): string | undefined {
  return (
    override ??
    stringDetail(operation, 'description') ??
    stringDetail(operation, 'summary') ??
    fallback
  )
}

function stringDetail(operation: McpRouteOperation, key: string): string | undefined {
  const value = operation.detail?.[key]
  return typeof value === 'string' && value.trim() ? value : undefined
}

function hasRouteInputSchema(operation: McpRouteOperation): boolean {
  return Boolean(operation.hooks.params || operation.hooks.query || operation.hooks.body)
}

function defaultAnnotationsForMethod(method: string) {
  switch (method) {
    case 'GET':
    case 'HEAD':
      return { readOnlyHint: true, idempotentHint: true }
    case 'PUT':
      return { readOnlyHint: false, idempotentHint: true }
    case 'DELETE':
      return { readOnlyHint: false, destructiveHint: true }
    default:
      return { readOnlyHint: false }
  }
}
