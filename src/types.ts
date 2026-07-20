import type { Elysia, HTTPMethod, InternalRoute } from 'elysia'

export type AnyElysiaApp = Elysia<any, any, any, any, any, any, any>

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonObject | JsonArray
export interface JsonObject {
  [key: string]: JsonValue
}
export interface JsonArray extends Array<JsonValue> {}

export type JsonSchema = Record<string, unknown>

export type McpRouteKind = 'tool' | 'resource' | 'prompt'
export type McpInputMode = 'envelope' | 'flatten'
export type McpNameCollisionStrategy = 'error' | 'suffix'

export type McpRouteMatcher =
  | string
  | RegExp
  | {
      method?: HTTPMethod | HTTPMethod[]
      path: string | RegExp
    }

export interface McpServerInfo {
  name: string
  version: string
  title?: string
  instructions?: string
}

export interface McpToolAnnotations {
  readOnlyHint?: boolean
  destructiveHint?: boolean
  idempotentHint?: boolean
  openWorldHint?: boolean
}

export interface McpAnnotations {
  audience?: Array<'user' | 'assistant'>
  priority?: number
  lastModified?: string
}

export interface McpIcon {
  src: string
  mimeType?: string
  sizes?: string[]
}

export interface McpResponseMarshalOptions {
  maxTextBytes?: number
  maxStructuredBytes?: number
  includeHttpMetadata?: boolean
  binary?: 'error' | 'base64'
}

export interface McpRouteResourceOptions {
  uri?: string
  uriTemplate?: string
  name?: string
  title?: string
  description?: string
  mimeType?: string
  annotations?: McpAnnotations
  mapUriToInput?: (
    variables: Record<string, string>,
    context: McpResourceInvocationContext
  ) => RouteInvocationInput
}

export interface McpRoutePromptOptions {
  argsSchema?: unknown
  arguments?: McpPromptArgument[]
  mapArgsToInput?: (
    args: Record<string, unknown>,
    context: McpPromptInvocationContext
  ) => RouteInvocationInput
}

export type McpRouteOptions =
  | false
  | {
      expose?: boolean
      kind?: McpRouteKind
      name?: string
      title?: string
      description?: string
      inputSchema?: unknown
      outputSchema?: unknown
      annotations?: McpToolAnnotations
      icons?: McpIcon[]
      resource?: McpRouteResourceOptions
      prompt?: McpRoutePromptOptions
      marshal?: McpResponseMarshalOptions
    }

export interface McpPluginOptions {
  server?: Partial<McpServerInfo>
  path?: string
  allowedRoutes?: '*' | McpRouteMatcher[]
  excludedRoutes?: McpRouteMatcher[]
  methods?: HTTPMethod[]
  operationNameResolver?: (operation: McpRouteOperation) => string
  defaultRouteKind?: 'tool'
  onNameCollision?: McpNameCollisionStrategy
  inputMode?: McpInputMode
  includeHiddenRoutes?: boolean
  headers?: {
    allowFromToolInput?: string[]
    passThroughFromMcpRequest?: string[]
  }
  marshal?: McpResponseMarshalOptions
  transport?: {
    validateOrigin?: boolean
    allowedOrigins?: string[]
    enableGetSse?: boolean
    enableDeleteSession?: boolean
    protocolVersion?: string
  }
  diagnostics?: {
    failOnMissingSchema?: boolean
  }
  mapJsonSchema?: (schema: unknown, context: McpSchemaMapContext) => unknown
}

export interface NormalizedMcpPluginOptions
  extends Required<
    Pick<
      McpPluginOptions,
      | 'path'
      | 'allowedRoutes'
      | 'excludedRoutes'
      | 'methods'
      | 'defaultRouteKind'
      | 'onNameCollision'
      | 'inputMode'
      | 'includeHiddenRoutes'
    >
  > {
  server: McpServerInfo
  headers: {
    allowFromToolInput: string[]
    passThroughFromMcpRequest: string[]
  }
  marshal: Required<McpResponseMarshalOptions>
  transport: Required<NonNullable<McpPluginOptions['transport']>>
  diagnostics: Required<NonNullable<McpPluginOptions['diagnostics']>>
  operationNameResolver: (operation: McpRouteOperation) => string
  mapJsonSchema?: (schema: unknown, context: McpSchemaMapContext) => unknown
}

export interface McpSchemaMapContext {
  source: 'route' | 'explicit'
  kind: McpRouteKind
  route?: McpRouteOperation
  schemaLocation:
    | 'input'
    | 'output'
    | 'params'
    | 'query'
    | 'body'
    | 'headers'
    | 'cookie'
    | 'promptArgs'
}

export interface McpRouteOperation {
  app: AnyElysiaApp
  route: InternalRoute
  method: HTTPMethod
  path: string
  hooks: Record<string, unknown>
  detail?: Record<string, unknown>
  mcp?: McpRouteOptions
}

export interface RouteInvocationInput {
  params?: Record<string, unknown>
  query?: Record<string, unknown>
  body?: unknown
  headers?: Record<string, unknown>
}

export interface McpInvocationContext {
  request: Request
  signal?: AbortSignal
  meta?: Record<string, unknown>
}

export interface McpResourceInvocationContext extends McpInvocationContext {
  uri: string
  variables: Record<string, string>
}

export interface McpPromptInvocationContext extends McpInvocationContext {
  name: string
}

export type McpTextContent = {
  type: 'text'
  text: string
  annotations?: McpAnnotations
}

export type McpImageContent = {
  type: 'image'
  data: string
  mimeType: string
  annotations?: McpAnnotations
}

export type McpAudioContent = {
  type: 'audio'
  data: string
  mimeType: string
  annotations?: McpAnnotations
}

export type McpResourceLinkContent = {
  type: 'resource_link'
  uri: string
  name?: string
  description?: string
  mimeType?: string
  annotations?: McpAnnotations
}

export type McpEmbeddedResourceContent = {
  type: 'resource'
  resource: McpResourceContent
  annotations?: McpAnnotations
}

export type McpContent =
  | McpTextContent
  | McpImageContent
  | McpAudioContent
  | McpResourceLinkContent
  | McpEmbeddedResourceContent

export interface McpToolResult {
  content: McpContent[]
  isError?: boolean
  structuredContent?: unknown
  _meta?: Record<string, unknown>
}

export interface McpToolDefinition {
  source: 'route' | 'explicit'
  name: string
  title?: string
  description?: string
  inputSchema: JsonSchema
  outputSchema?: JsonSchema
  annotations?: McpToolAnnotations
  icons?: McpIcon[]
  invoke: (args: unknown, context: McpInvocationContext) => Promise<McpToolResult>
}

export interface McpResourceContent {
  uri: string
  mimeType?: string
  text?: string
  blob?: string
  annotations?: McpAnnotations
}

export interface McpResourceReadResult {
  contents: McpResourceContent[]
  _meta?: Record<string, unknown>
}

export interface McpResourceDefinition {
  source: 'route' | 'explicit'
  uri: string
  name: string
  title?: string
  description?: string
  mimeType?: string
  annotations?: McpAnnotations
  icons?: McpIcon[]
  read: (context: McpResourceInvocationContext) => Promise<McpResourceReadResult>
}

export interface McpResourceTemplateDefinition {
  source: 'route' | 'explicit'
  uriTemplate: string
  name: string
  title?: string
  description?: string
  mimeType?: string
  annotations?: McpAnnotations
  icons?: McpIcon[]
  read: (context: McpResourceInvocationContext) => Promise<McpResourceReadResult>
}

export interface McpPromptArgument {
  name: string
  title?: string
  description?: string
  required?: boolean
}

export interface McpPromptMessage {
  role: 'user' | 'assistant'
  content: McpContent
}

export interface McpPromptResult {
  description?: string
  messages: McpPromptMessage[]
  _meta?: Record<string, unknown>
}

export interface McpPromptDefinition {
  source: 'route' | 'explicit'
  name: string
  title?: string
  description?: string
  arguments?: McpPromptArgument[]
  argsSchema?: JsonSchema
  icons?: McpIcon[]
  get: (
    args: Record<string, unknown>,
    context: McpPromptInvocationContext
  ) => Promise<McpPromptResult>
}

export interface McpRegistry {
  tools: Map<string, McpToolDefinition>
  resources: Map<string, McpResourceDefinition>
  resourceTemplates: Map<string, McpResourceTemplateDefinition>
  prompts: Map<string, McpPromptDefinition>
}

export type McpToolHandler<Input = unknown> = (
  input: Input,
  context: McpInvocationContext
) => Promise<McpToolResult | unknown> | McpToolResult | unknown

export type McpResourceHandler = (
  context: McpResourceInvocationContext
) =>
  | Promise<McpResourceReadResult | McpResourceContent[] | McpResourceContent | unknown>
  | McpResourceReadResult
  | McpResourceContent[]
  | McpResourceContent
  | unknown

export type McpPromptHandler<Args extends Record<string, unknown> = Record<string, unknown>> = (
  args: Args,
  context: McpPromptInvocationContext
) =>
  | Promise<McpPromptResult | McpPromptMessage[] | string>
  | McpPromptResult
  | McpPromptMessage[]
  | string

export interface McpToolOptions {
  title?: string
  description?: string
  inputSchema?: unknown
  outputSchema?: unknown
  annotations?: McpToolAnnotations
  icons?: McpIcon[]
}

export interface McpResourceOptions {
  name?: string
  title?: string
  description?: string
  mimeType?: string
  annotations?: McpAnnotations
  icons?: McpIcon[]
}

export interface McpPromptOptions {
  title?: string
  description?: string
  argsSchema?: unknown
  arguments?: McpPromptArgument[]
  icons?: McpIcon[]
}

export interface McpAdapterState {
  explicitTools: Map<string, ExplicitToolRegistration>
  explicitResources: Map<string, ExplicitResourceRegistration>
  explicitPrompts: Map<string, ExplicitPromptRegistration>
  version: number
  registryCache?: {
    fingerprint: string
    version: number
    registry: McpRegistry
  }
}

export interface ExplicitToolRegistration {
  name: string
  handler: McpToolHandler<any>
  options: McpToolOptions
}

export interface ExplicitResourceRegistration {
  uriOrTemplate: string
  handler: McpResourceHandler
  options: McpResourceOptions
}

export interface ExplicitPromptRegistration {
  name: string
  handler: McpPromptHandler<any>
  options: McpPromptOptions
}

export interface JsonRpcRequest {
  jsonrpc: '2.0'
  id?: string | number | null
  method?: string
  params?: Record<string, unknown>
}

export interface JsonRpcResponse {
  jsonrpc: '2.0'
  id?: string | number | null
  result?: unknown
  error?: {
    code: number
    message: string
    data?: unknown
  }
}
