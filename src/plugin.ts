import type { Elysia } from 'elysia'
import { installMcpMethods } from './methods/install.js'
import { normalizeOptions } from './options.js'
import { ensureMcpState } from './state.js'
import { handleMcpHttpRequest } from './transport/json-rpc.js'
import type { AnyElysiaApp, McpPluginOptions, McpRouteOptions } from './types.js'

export function mcp(options: McpPluginOptions = {}) {
  const normalized = normalizeOptions(options)

  return function elysiaMcpAdapter<T extends AnyElysiaApp>(app: T) {
    ensureMcpState(app)
    installMcpMethods(app)

    const withMacro = app.macro({
      mcp: (_options: McpRouteOptions) => ({})
    })

    return withMacro.all(
      normalized.path,
      (context: any) =>
        handleMcpHttpRequest(withMacro as AnyElysiaApp, context.request, normalized),
      {
        mcp: false,
        parse: 'none',
        detail: {
          hide: true,
          tags: ['MCP'],
          summary: 'Model Context Protocol endpoint'
        }
      }
    )
  }
}

export function withMcpMethods() {
  return function elysiaMcpMethods<T extends Elysia<any, any, any, any, any, any, any>>(app: T): T {
    ensureMcpState(app as AnyElysiaApp)
    installMcpMethods(app as AnyElysiaApp)
    return app
  }
}
