import type { DefinitionBase, EphemeralType, MetadataBase, RouteBase, SingletonBase } from 'elysia'
import { mcp, withMcpMethods } from './plugin.js'

export * from './extensions/apps/index.js'
export * from './extensions/auth/index.js'
export type {
  McpExtensionSource,
  McpExtensionStatus,
  McpExtensionVersionRecord,
  McpProtocolVersion
} from './extensions/manifest.js'
export { MCP_EXTENSION_SUPPORT } from './extensions/manifest.js'
export * from './extensions/tasks/index.js'
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
  McpContent,
  McpExtensionOptions,
  McpIcon,
  McpInputMode,
  McpInvocationContext,
  McpNameCollisionStrategy,
  McpPluginOptions,
  McpPromptArgument,
  McpPromptHandler,
  McpPromptMessage,
  McpPromptOptions,
  McpPromptResult,
  McpRegistry,
  McpResourceContent,
  McpResourceHandler,
  McpResourceOptions,
  McpResourceReadResult,
  McpResponseMarshalOptions,
  McpRouteKind,
  McpRouteMatcher,
  McpRouteOperation,
  McpRouteOptions,
  McpServerInfo,
  McpTasksOptions,
  McpToolAnnotations,
  McpToolHandler,
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
  }
}
