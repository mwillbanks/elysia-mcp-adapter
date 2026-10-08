import type { Elysia, HTTPMethod, InternalRoute } from 'elysia'
import type { McpActionMetadata, McpTrustAnnotations } from './extensions/annotations/index.js'
import type {
  McpAppsProtocolVersionSelector,
  McpAppsResourceCsp,
  McpAppsResourceMeta,
  McpAppsResourcePermissions,
  McpAppsToolMeta
} from './extensions/apps/index.js'
import type {
  McpAuthOptions,
  McpAuthorizationContext,
  McpAuthVersion
} from './extensions/auth/index.js'
import type {
  McpEventRegistration,
  McpEventsOptions,
  NormalizedMcpEventsOptions
} from './extensions/events/index.js'
import type {
  McpInterceptorRegistration,
  McpInterceptorsOptions
} from './extensions/interceptors/index.js'
import type { McpProtocolVersion } from './extensions/manifest.js'
import type { McpServerCardOptions } from './extensions/server-card/index.js'
import type {
  ExplicitSkillRegistration,
  McpSkillDefinition,
  McpSkillsOptions
} from './extensions/skills/index.js'
import type {
  TaskController,
  TaskExecutionMode,
  TaskProvider,
  TasksVersionInput
} from './extensions/tasks/index.js'
import type { McpVariantsOptions } from './extensions/variants/index.js'

export type AnyElysiaApp = Elysia<any, any, any, any, any, any, any>

export type JsonSchema = Record<string, unknown>

export type McpRouteKind = 'tool' | 'resource' | 'prompt'
export type McpInputMode = 'envelope' | 'flatten'
export type McpNameCollisionStrategy = 'error' | 'suffix'

export interface McpAuthorizationOptions {
  requiredScopes?: readonly string[]
}

export interface McpAppsOptions {
  version?: McpAppsProtocolVersionSelector
  includeDeprecatedResourceUri?: boolean
}

export interface McpTasksOptions {
  version?: TasksVersionInput
  provider: TaskProvider
  defaultTtl?: number | null
  pollInterval?: number
}

export interface McpExtensionOptions {
  tasks?: McpTasksOptions
  auth?: McpAuthOptions
  apps?: McpAppsOptions
  skills?: McpSkillsOptions
  serverCard?: McpServerCardOptions
  interceptors?: McpInterceptorsOptions
  variants?: McpVariantsOptions
  events?: McpEventsOptions
}

export interface McpClientInfo {
  name: string
  version: string
  title?: string
  description?: string
  websiteUrl?: string
  icons?: McpIcon[]
}

export interface McpElicitationFormRequest {
  method: 'elicitation/create'
  params: {
    mode?: 'form'
    message: string
    requestedSchema: JsonSchema
  }
}

export interface McpElicitationUrlRequest {
  method: 'elicitation/create'
  params: {
    mode: 'url'
    message: string
    url: string
  }
}

export interface McpSamplingMessage {
  role: 'user' | 'assistant'
  content: McpSamplingContent | McpSamplingContent[]
  _meta?: Record<string, unknown>
}

export interface McpSamplingToolUseContent {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, unknown>
  _meta?: Record<string, unknown>
}

export interface McpSamplingToolResultContent {
  type: 'tool_result'
  toolUseId: string
  content: McpContent[]
  structuredContent?: unknown
  isError?: boolean
  _meta?: Record<string, unknown>
}

export type McpSamplingContent =
  | McpTextContent
  | McpImageContent
  | McpAudioContent
  | McpSamplingToolUseContent
  | McpSamplingToolResultContent

export interface McpSamplingRequest {
  method: 'sampling/createMessage'
  params: {
    messages: McpSamplingMessage[]
    maxTokens: number
    systemPrompt?: string
    includeContext?: 'none' | 'thisServer' | 'allServers'
    temperature?: number
    stopSequences?: string[]
    modelPreferences?: {
      hints?: Array<{ name?: string }>
      costPriority?: number
      speedPriority?: number
      intelligencePriority?: number
    }
    metadata?: Record<string, unknown>
    tools?: Array<Record<string, unknown>>
    toolChoice?: { mode?: 'auto' | 'required' | 'none' }
  }
}

export interface McpRootsRequest {
  method: 'roots/list'
  params?: Record<string, never>
}

export type McpInputRequest =
  | McpElicitationFormRequest
  | McpElicitationUrlRequest
  | McpSamplingRequest
  | McpRootsRequest

export interface McpElicitationResult {
  action: 'accept' | 'decline' | 'cancel'
  content?: Record<string, string | number | boolean | string[]>
}

export interface McpSamplingResult {
  role: 'user' | 'assistant'
  content: McpSamplingContent | McpSamplingContent[]
  model: string
  stopReason?: string
  _meta?: Record<string, unknown>
}

export interface McpRootsResult {
  roots: Array<{ uri: string; name?: string; _meta?: Record<string, unknown> }>
}

export type McpInputResponse = McpElicitationResult | McpSamplingResult | McpRootsResult
export type McpInputResponses = Record<string, McpInputResponse>

export interface McpInputRequiredResult {
  resultType: 'input_required'
  inputRequests?: Record<string, McpInputRequest>
  requestState?: string
  _meta?: Record<string, unknown>
}

export interface McpContinuationProvider {
  consume(
    id: string,
    context: { request: Request; principalKey?: string; expiresAt: number }
  ): boolean | Promise<boolean>
}

export interface McpContinuationOptions {
  signingKey: string | Uint8Array
  ttlMs?: number
  singleUse?: boolean
  provider?: McpContinuationProvider
}

export interface McpPaginationOptions {
  pageSize: number
  signingKey: string | Uint8Array
  cursorTtlMs?: number
}

export interface McpCachePolicy {
  cacheScope: 'private' | 'public'
  ttlMs: number
}

export interface McpCacheOptions {
  default?: Partial<McpCachePolicy>
  policy?: (
    method: string,
    context: McpInvocationContext
  ) => Partial<McpCachePolicy> | Promise<Partial<McpCachePolicy>>
}

export interface McpCompletionReference {
  type: 'ref/prompt' | 'ref/resource'
  name?: string
  uri?: string
}

export interface McpCompletionRequest {
  ref: McpCompletionReference
  argument: { name: string; value: string }
  context?: { arguments?: Record<string, string> }
}

export interface McpCompletionResult {
  values: string[]
  total?: number
  hasMore?: boolean
}

export type McpCompletionHandler = (
  request: McpCompletionRequest,
  context: McpInvocationContext
) => McpCompletionResult | Promise<McpCompletionResult>

export interface McpSubscriptionFilter {
  toolsListChanged?: boolean
  promptsListChanged?: boolean
  resourcesListChanged?: boolean
  resourceSubscriptions?: string[]
  taskIds?: string[]
}

export type McpServerNotification =
  | { method: 'notifications/tools/list_changed'; params?: Record<string, unknown> }
  | { method: 'notifications/events/list_changed'; params?: Record<string, unknown> }
  | { method: 'notifications/prompts/list_changed'; params?: Record<string, unknown> }
  | { method: 'notifications/resources/list_changed'; params?: Record<string, unknown> }
  | { method: 'notifications/resources/updated'; params: { uri: string } }

export interface McpSubscriptionProvider {
  subscribe(
    filter: Readonly<McpSubscriptionFilter>,
    context: McpInvocationContext
  ): AsyncIterable<McpServerNotification> | Promise<AsyncIterable<McpServerNotification>>
}

export interface McpSubscriptionOptions {
  provider: McpSubscriptionProvider
  toolsListChanged?: boolean
  promptsListChanged?: boolean
  resourcesListChanged?: boolean
  resources?: boolean
  heartbeatMs?: number
}

export interface McpCoreOptions {
  /** Reject tool inputs whose nested object members and array elements exceed this limit. */
  maxToolInputElements?: number
  continuation?: McpContinuationOptions
  pagination?: McpPaginationOptions
  cache?: McpCacheOptions
  subscriptions?: McpSubscriptionOptions
}

export type McpAppToolOptions = McpAppsToolMeta & { resourceUri: string }
export type McpAppCsp = McpAppsResourceCsp
export type McpAppPermissions = McpAppsResourcePermissions
export type McpAppResourceMetadata = McpAppsResourceMeta & Record<string, unknown>

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
  'io.modelcontextprotocol/action-metadata'?: McpActionMetadata
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
  theme?: 'dark' | 'light'
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
  authorization?: McpAuthorizationOptions
  app?: McpAppResourceMetadata
  complete?: McpCompletionHandler
  mapUriToInput?: (
    variables: Record<string, string>,
    context: McpResourceInvocationContext
  ) => RouteInvocationInput
}

export interface McpRoutePromptOptions {
  argsSchema?: unknown
  arguments?: McpPromptArgument[]
  complete?: McpCompletionHandler
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
      authorization?: McpAuthorizationOptions
      taskExecution?: TaskExecutionMode
      app?: McpAppToolOptions
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
    protocolVersions?: McpProtocolVersion[]
  }
  extensions?: McpExtensionOptions
  core?: McpCoreOptions
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
  extensions: {
    tasks?: McpTasksOptions & { version: Exclude<TasksVersionInput, 'current'> }
    auth?: McpAuthOptions & { version: Exclude<McpAuthVersion, 'current'> }
    apps?: McpAppsOptions & { version: '2026-01-26' | 'draft' }
    skills?: McpSkillsOptions & {
      version: Exclude<NonNullable<McpSkillsOptions['version']>, 'current'>
      directoryRead: boolean
      pagination?: McpPaginationOptions & { cursorTtlMs: number }
      cache: McpCachePolicy
    }
    serverCard?: Required<McpServerCardOptions>
    interceptors?: McpInterceptorsOptions & {
      version: Exclude<NonNullable<McpInterceptorsOptions['version']>, 'current'>
    }
    variants?: McpVariantsOptions & {
      version: Exclude<NonNullable<McpVariantsOptions['version']>, 'current'>
      discoveryLimit: number
    }
    events?: NormalizedMcpEventsOptions
  }
  core: {
    maxToolInputElements?: number
    continuation?: McpContinuationOptions & { ttlMs: number; singleUse: boolean }
    pagination?: McpPaginationOptions & { cursorTtlMs: number }
    cache: {
      default: McpCachePolicy
      policy?: McpCacheOptions['policy']
    }
    subscriptions?: McpSubscriptionOptions & { heartbeatMs: number }
  }
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
  protocolVersion?: McpProtocolVersion
  clientCapabilities?: Record<string, unknown>
  clientInfo?: McpClientInfo
  inputResponses?: McpInputResponses
  requestState?: string
  reportProgress?: (progress: number, options?: { total?: number; message?: string }) => void
  authorization?: Readonly<McpAuthorizationContext>
  task?: TaskController
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
  _meta?: Record<string, unknown> & {
    'io.modelcontextprotocol/trust-annotations'?: McpTrustAnnotations
  }
}

export type McpToolHandlerResult = McpToolResult | McpInputRequiredResult

export interface McpToolDefinition {
  source: 'route' | 'explicit'
  name: string
  title?: string
  description?: string
  inputSchema: JsonSchema
  outputSchema?: JsonSchema
  annotations?: McpToolAnnotations
  icons?: McpIcon[]
  authorization?: McpAuthorizationOptions
  taskExecution?: TaskExecutionMode
  app?: McpAppToolOptions
  invoke: (args: unknown, context: McpInvocationContext) => Promise<McpToolHandlerResult>
}

export interface McpResourceContent {
  uri: string
  mimeType?: string
  text?: string
  blob?: string
  annotations?: McpAnnotations
  _meta?: Record<string, unknown>
}

export interface McpResourceReadResult {
  contents: McpResourceContent[]
  _meta?: Record<string, unknown>
}

export type McpResourceHandlerResult = McpResourceReadResult | McpInputRequiredResult

export interface McpResourceDefinition {
  source: 'route' | 'explicit'
  uri: string
  name: string
  title?: string
  description?: string
  mimeType?: string
  annotations?: McpAnnotations
  icons?: McpIcon[]
  authorization?: McpAuthorizationOptions
  app?: McpAppResourceMetadata
  complete?: McpCompletionHandler
  read: (context: McpResourceInvocationContext) => Promise<McpResourceHandlerResult>
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
  authorization?: McpAuthorizationOptions
  app?: McpAppResourceMetadata
  complete?: McpCompletionHandler
  read: (context: McpResourceInvocationContext) => Promise<McpResourceHandlerResult>
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

export type McpPromptHandlerResult = McpPromptResult | McpInputRequiredResult

export interface McpPromptDefinition {
  source: 'route' | 'explicit'
  name: string
  title?: string
  description?: string
  arguments?: McpPromptArgument[]
  argsSchema?: JsonSchema
  icons?: McpIcon[]
  authorization?: McpAuthorizationOptions
  complete?: McpCompletionHandler
  get: (
    args: Record<string, unknown>,
    context: McpPromptInvocationContext
  ) => Promise<McpPromptHandlerResult>
}

export interface McpRegistry {
  tools: Map<string, McpToolDefinition>
  resources: Map<string, McpResourceDefinition>
  resourceTemplates: Map<string, McpResourceTemplateDefinition>
  prompts: Map<string, McpPromptDefinition>
  skills?: Map<string, McpSkillDefinition>
  events?: Map<string, McpEventRegistration>
}

export type McpToolHandler<Input = unknown> = (
  input: Input,
  context: McpInvocationContext
) => Promise<McpToolHandlerResult | unknown> | McpToolHandlerResult | unknown

export type McpResourceHandler = (
  context: McpResourceInvocationContext
) =>
  | Promise<
      | McpResourceReadResult
      | McpResourceContent[]
      | McpResourceContent
      | McpInputRequiredResult
      | unknown
    >
  | McpInputRequiredResult
  | McpResourceReadResult
  | McpResourceContent[]
  | McpResourceContent
  | unknown

export type McpPromptHandler<Args extends Record<string, unknown> = Record<string, unknown>> = (
  args: Args,
  context: McpPromptInvocationContext
) =>
  | Promise<McpPromptResult | McpPromptMessage[] | McpInputRequiredResult | string>
  | McpInputRequiredResult
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
  authorization?: McpAuthorizationOptions
  taskExecution?: TaskExecutionMode
  app?: McpAppToolOptions
}

export interface McpResourceOptions {
  name?: string
  title?: string
  description?: string
  mimeType?: string
  annotations?: McpAnnotations
  icons?: McpIcon[]
  authorization?: McpAuthorizationOptions
  app?: McpAppResourceMetadata
  complete?: McpCompletionHandler
}

export interface McpPromptOptions {
  title?: string
  description?: string
  argsSchema?: unknown
  arguments?: McpPromptArgument[]
  icons?: McpIcon[]
  authorization?: McpAuthorizationOptions
  complete?: McpCompletionHandler
}

export interface McpAdapterState {
  explicitTools: Map<string, ExplicitToolRegistration>
  explicitResources: Map<string, ExplicitResourceRegistration>
  explicitPrompts: Map<string, ExplicitPromptRegistration>
  explicitSkills?: Map<string, ExplicitSkillRegistration>
  explicitInterceptors?: Map<string, McpInterceptorRegistration>
  explicitEvents?: Map<string, McpEventRegistration>
  version: number
  registryCache?: {
    fingerprint: string
    version: number
    options?: NormalizedMcpPluginOptions
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
