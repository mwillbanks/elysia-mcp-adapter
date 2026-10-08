import { assertToolAnnotationExtensions } from './extensions/annotations/index.js'
import {
  assertCompatibleSkillDefinitions,
  buildSkillDefinition
} from './extensions/skills/index.js'
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

type RouteMcpOptions = Exclude<McpRouteOperation['mcp'], false | undefined>

export function getMcpRegistry(
  app: AnyElysiaApp,
  options: NormalizedMcpPluginOptions
): McpRegistry & {
  skills: NonNullable<McpRegistry['skills']>
  events: NonNullable<McpRegistry['events']>
} {
  const state = ensureMcpState(app)
  const fingerprint = routeFingerprint(app)

  if (
    state.registryCache &&
    state.registryCache.version === state.version &&
    state.registryCache.fingerprint === fingerprint &&
    state.registryCache.options === options &&
    state.registryCache.registry.skills &&
    state.registryCache.registry.events
  ) {
    return state.registryCache.registry as McpRegistry & {
      skills: NonNullable<McpRegistry['skills']>
      events: NonNullable<McpRegistry['events']>
    }
  }

  const registry = buildMcpRegistry(app, options)
  state.registryCache = {
    fingerprint,
    version: state.version,
    options,
    registry
  }

  return registry
}

function buildMcpRegistry(
  app: AnyElysiaApp,
  options: NormalizedMcpPluginOptions
): McpRegistry & {
  skills: NonNullable<McpRegistry['skills']>
  events: NonNullable<McpRegistry['events']>
} {
  const state = ensureMcpState(app)
  const registry: McpRegistry & {
    skills: NonNullable<McpRegistry['skills']>
    events: NonNullable<McpRegistry['events']>
  } = {
    tools: new Map(),
    resources: new Map(),
    resourceTemplates: new Map(),
    prompts: new Map(),
    skills: new Map(),
    events: new Map()
  }
  addExplicitDefinitions(state, registry, options)
  addRouteDefinitions(app, registry, options)
  return registry
}

function addExplicitDefinitions(
  state: ReturnType<typeof ensureMcpState>,
  registry: McpRegistry & {
    skills: NonNullable<McpRegistry['skills']>
    events: NonNullable<McpRegistry['events']>
  },
  options: NormalizedMcpPluginOptions
): void {
  addExplicitTools(state, registry, options)
  addExplicitResources(state, registry, options)
  addExplicitPrompts(state, registry, options)
  addExplicitSkills(state, registry, options)
  addExplicitEvents(state, registry)
}

function addExplicitTools(
  state: ReturnType<typeof ensureMcpState>,
  registry: McpRegistry,
  options: NormalizedMcpPluginOptions
): void {
  for (const tool of state.explicitTools.values()) {
    addTool(registry, createExplicitTool(tool, options), options)
  }
}

function addExplicitResources(
  state: ReturnType<typeof ensureMcpState>,
  registry: McpRegistry,
  options: NormalizedMcpPluginOptions
): void {
  for (const resource of state.explicitResources.values()) {
    const definition = createExplicitResource(resource, options)
    if ('uriTemplate' in definition) addResourceTemplate(registry, definition, options)
    else addResource(registry, definition, options)
  }
}

function addExplicitPrompts(
  state: ReturnType<typeof ensureMcpState>,
  registry: McpRegistry,
  options: NormalizedMcpPluginOptions
): void {
  for (const prompt of state.explicitPrompts.values()) {
    addPrompt(registry, createExplicitPrompt(prompt, options), options)
  }
}

function addExplicitSkills(
  state: ReturnType<typeof ensureMcpState>,
  registry: McpRegistry & { skills: NonNullable<McpRegistry['skills']> },
  options: NormalizedMcpPluginOptions
): void {
  for (const skill of state.explicitSkills.values()) {
    const definition = buildSkillDefinition(skill)
    if (
      options.extensions.skills?.directoryRead &&
      definition.entry.resources === 'dynamic' &&
      !definition.readDirectory
    ) {
      throw new TypeError(
        `Dynamic skill ${definition.uri} requires readDirectory when directoryRead is enabled`
      )
    }
    if (registry.skills.has(definition.uri)) {
      throw new TypeError(`Duplicate MCP skill: ${definition.uri}`)
    }
    assertCompatibleSkillDefinitions(registry.skills.values(), definition)
    registry.skills.set(definition.uri, definition)
  }
}

function addExplicitEvents(
  state: ReturnType<typeof ensureMcpState>,
  registry: McpRegistry & { events: NonNullable<McpRegistry['events']> }
): void {
  for (const event of state.explicitEvents.values()) {
    if (registry.events.has(event.definition.name))
      throw new TypeError(`Duplicate MCP event: ${event.definition.name}`)
    registry.events.set(event.definition.name, event)
  }
}

function addRouteDefinitions(
  app: AnyElysiaApp,
  registry: McpRegistry,
  options: NormalizedMcpPluginOptions
): void {
  for (const operation of listRouteOperations(app)) {
    if (!shouldExposeRoute(operation, options)) continue
    addRouteDefinition(registry, operation, resolveRouteKind(operation, options), options)
  }
}

function addRouteDefinition(
  registry: McpRegistry,
  operation: McpRouteOperation,
  kind: McpRouteKind,
  options: NormalizedMcpPluginOptions
): void {
  if (kind === 'tool') {
    addTool(registry, createRouteTool(operation, options), options)
    return
  }
  if (kind === 'prompt') {
    addPrompt(registry, createRoutePrompt(operation, options), options)
    return
  }
  const definition = createRouteResource(operation, options)
  if (!definition) return
  if ('uriTemplate' in definition) addResourceTemplate(registry, definition, options)
  else addResource(registry, definition, options)
}

function createExplicitTool(
  registration: ExplicitToolRegistration,
  options: NormalizedMcpPluginOptions
): McpToolDefinition {
  assertToolAnnotationExtensions(registration.options.annotations)
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
    complete: registration.options.complete,
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
    complete: registration.options.complete,
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
  const routeMcp = routeMcpOptions(operation)
  const inputSchema = composeRouteInputSchema(operation, 'tool', options)
  const outputSchema = composeRouteOutputSchema(operation, 'tool', options)
  const name = sanitizeMcpName(
    firstDefined(routeMcp.name, options.operationNameResolver(operation))
  )
  assertToolAnnotationExtensions(routeMcp.annotations)
  assertRouteToolSchema(operation, Boolean(routeMcp.inputSchema), options)

  return {
    source: 'route',
    name,
    title: routeTitle(operation, name, routeMcp.title),
    description: routeDescription(
      operation,
      routeMcp.description,
      `${operation.method} ${operation.path}`
    ),
    inputSchema,
    outputSchema,
    annotations: firstDefined(routeMcp.annotations, defaultAnnotationsForMethod(operation.method)),
    icons: routeMcp.icons,
    authorization: routeMcp.authorization,
    taskExecution: firstDefined(routeMcp.taskExecution, 'optional'),
    app: routeMcp.app,
    invoke: (args, context) => invokeRouteTool(operation, args ?? {}, inputSchema, context, options)
  }
}

function assertRouteToolSchema(
  operation: McpRouteOperation,
  hasOverride: boolean,
  options: NormalizedMcpPluginOptions
): void {
  if (!options.diagnostics.failOnMissingSchema || hasOverride || hasRouteInputSchema(operation))
    return
  throw new Error(`Missing input schema for MCP route tool ${operation.method} ${operation.path}`)
}

function createRouteResource(
  operation: McpRouteOperation,
  options: NormalizedMcpPluginOptions
): McpResourceDefinition | McpResourceTemplateDefinition | undefined {
  const routeMcp = routeMcpOptions(operation)
  const resource = routeMcp.resource

  if (!resource) return undefined
  const uriOrTemplate = resource.uriTemplate ?? resource.uri
  if (!uriOrTemplate) return undefined
  const name = sanitizeMcpName(
    firstDefined(routeMcp.name, resource.name, templateName(uriOrTemplate))
  )
  const base = routeResourceBase(operation, options, routeMcp, resource, name)
  return resource.uriTemplate
    ? { ...base, uriTemplate: resource.uriTemplate }
    : { ...base, uri: uriOrTemplate }
}

function routeResourceBase(
  operation: McpRouteOperation,
  options: NormalizedMcpPluginOptions,
  routeMcp: Partial<RouteMcpOptions>,
  resource: NonNullable<RouteMcpOptions['resource']>,
  name: string
) {
  return {
    source: 'route' as const,
    name,
    title: routeTitle(operation, name, firstDefined(resource.title, routeMcp.title)),
    description: routeDescription(
      operation,
      firstDefined(resource.description, routeMcp.description)
    ),
    mimeType: resource.mimeType,
    annotations: resource.annotations,
    icons: routeMcp.icons,
    authorization: firstDefined(resource.authorization, routeMcp.authorization),
    app: resource.app,
    complete: resource.complete,
    read: (context: any) => invokeRouteResource(operation, context, options)
  }
}

function createRoutePrompt(
  operation: McpRouteOperation,
  options: NormalizedMcpPluginOptions
): McpPromptDefinition {
  const routeMcp = routeMcpOptions(operation)
  const argsSchema = composeRouteInputSchema(operation, 'prompt', options)
  const name = sanitizeMcpName(
    firstDefined(routeMcp.name, options.operationNameResolver(operation))
  )
  const prompt = routeMcp.prompt
  return {
    source: 'route',
    name,
    title: routeTitle(operation, name, routeMcp.title),
    description: routeDescription(operation, routeMcp.description),
    argsSchema,
    arguments: firstDefined(prompt?.arguments, promptArgumentsFromSchema(argsSchema)),
    icons: routeMcp.icons,
    authorization: routeMcp.authorization,
    complete: prompt?.complete,
    get: async (args, context) => {
      assertValidPromptArgs(argsSchema, args ?? {})
      return invokeRoutePrompt(operation, args ?? {}, context, options)
    }
  }
}

function routeMcpOptions(operation: McpRouteOperation): Partial<RouteMcpOptions> {
  return operation.mcp === false || operation.mcp === undefined ? {} : operation.mcp
}

function firstDefined<T>(...values: readonly (T | undefined)[]): T {
  const value = values.find((candidate) => candidate !== undefined)
  return value as T
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
