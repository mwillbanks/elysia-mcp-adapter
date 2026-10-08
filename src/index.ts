import type { DefinitionBase, EphemeralType, MetadataBase, RouteBase, SingletonBase } from 'elysia'
import { mcp, withMcpMethods } from './plugin.js'

export {
  DEFAULT_PROTOCOL_VERSION,
  LEGACY_PROTOCOL_VERSION,
  MCP_CORE_CAPABILITIES
} from './constants.js'
export * from './extensions/annotations/index.js'
export * from './extensions/apps/index.js'
export * from './extensions/auth/index.js'
export * from './extensions/events/index.js'
export * from './extensions/interceptors/index.js'
export type {
  McpExtensionMaturity,
  McpExtensionSource,
  McpExtensionStatus,
  McpExtensionVersionRecord,
  McpLatestExtensionRecord,
  McpProtocolVersion
} from './extensions/manifest.js'
export {
  MCP_EXTENSION_LATEST_REVIEWED,
  MCP_EXTENSION_SUPPORT,
  resolveLatestReviewedVersion
} from './extensions/manifest.js'
export * from './extensions/server-card/index.js'
export * from './extensions/skills/index.js'
export * from './extensions/tasks/index.js'
export * from './extensions/variants/index.js'
export { getMcpInvocationContext } from './invoke/context.js'
export { defaultOperationNameResolver, sanitizeMcpName } from './naming.js'
export { getMcpRegistry } from './registry.js'
export type {
  JsonSchema,
  McpAdapterState,
  McpAnnotations,
  McpAppCsp,
  McpAppPermissions,
  McpAppResourceMetadata,
  McpAppsOptions,
  McpAppToolOptions,
  McpAuthorizationOptions,
  McpCacheOptions,
  McpCachePolicy,
  McpClientInfo,
  McpCompletionHandler,
  McpCompletionReference,
  McpCompletionRequest,
  McpCompletionResult,
  McpContent,
  McpContinuationOptions,
  McpContinuationProvider,
  McpCoreOptions,
  McpElicitationFormRequest,
  McpElicitationResult,
  McpElicitationUrlRequest,
  McpExtensionOptions,
  McpIcon,
  McpInputMode,
  McpInputRequest,
  McpInputRequiredResult,
  McpInputResponse,
  McpInputResponses,
  McpInvocationContext,
  McpNameCollisionStrategy,
  McpPaginationOptions,
  McpPluginOptions,
  McpPromptArgument,
  McpPromptHandler,
  McpPromptHandlerResult,
  McpPromptMessage,
  McpPromptOptions,
  McpPromptResult,
  McpRegistry,
  McpResourceContent,
  McpResourceHandler,
  McpResourceHandlerResult,
  McpResourceOptions,
  McpResourceReadResult,
  McpResponseMarshalOptions,
  McpRootsRequest,
  McpRootsResult,
  McpRouteKind,
  McpRouteMatcher,
  McpRouteOperation,
  McpRouteOptions,
  McpSamplingContent,
  McpSamplingMessage,
  McpSamplingRequest,
  McpSamplingResult,
  McpSamplingToolResultContent,
  McpSamplingToolUseContent,
  McpServerInfo,
  McpServerNotification,
  McpSubscriptionFilter,
  McpSubscriptionOptions,
  McpSubscriptionProvider,
  McpTasksOptions,
  McpToolAnnotations,
  McpToolHandler,
  McpToolHandlerResult,
  McpToolOptions,
  McpToolResult,
  RouteInvocationInput
} from './types.js'
export { mcp, withMcpMethods }

declare module 'elysia' {
  interface Elysia<
    in out BasePath extends string = '',
    in out Singleton extends SingletonBase = {
      decorator: {}
      store: {}
      derive: {}
      resolve: {}
    },
    in out Definitions extends DefinitionBase = {
      typebox: {}
      error: {}
    },
    in out Metadata extends MetadataBase = {
      schema: {}
      standaloneSchema: {}
      macro: {}
      macroFn: {}
      parser: {}
      response: {}
    },
    in out Routes extends RouteBase = {},
    in out Ephemeral extends EphemeralType = {
      derive: {}
      resolve: {}
      schema: {}
      standaloneSchema: {}
      response: {}
    },
    in out Volatile extends EphemeralType = {
      derive: {}
      resolve: {}
      schema: {}
      standaloneSchema: {}
      response: {}
    }
  > {
    mcpTool<Input = unknown>(
      name: string,
      handler: import('./types.js').McpToolHandler<Input>,
      options?: import('./types.js').McpToolOptions
    ): this

    mcpResource(
      uriOrTemplate: string,
      handler: import('./types.js').McpResourceHandler,
      options?: import('./types.js').McpResourceOptions
    ): this

    mcpPrompt<Args extends Record<string, unknown> = Record<string, unknown>>(
      name: string,
      handler: import('./types.js').McpPromptHandler<Args>,
      options?: import('./types.js').McpPromptOptions
    ): this

    mcpSkill(
      uri: string,
      skill: import('./extensions/skills/index.js').McpSkillBytes,
      options?: import('./extensions/skills/index.js').McpSkillRegistrationOptions
    ): this

    mcpInterceptor(
      definition: import('./extensions/interceptors/index.js').McpInterceptorDefinition,
      handler: import('./extensions/interceptors/index.js').McpInterceptorHandler
    ): this

    mcpEvent(
      definition: import('./extensions/events/index.js').McpEventDefinition,
      handler: import('./extensions/events/index.js').McpEventHandler
    ): this
  }
}
