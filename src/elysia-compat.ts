import { Elysia } from 'elysia'
import type { AnyElysiaApp, McpRouteOptions } from './types.js'

export const MCP_ROUTE_OPTIONS = Symbol('MCP route options')
export const MCP_ROUTE_DETAIL = 'x-elysia-mcp-adapter'
export const MCP_ROUTE_DENIED = 'x-elysia-mcp-adapter-denied'
let supportsV1Introspection: boolean | undefined

export function usesElysia2(app: AnyElysiaApp): boolean {
  return '~routes' in app
}

export function registerAdapterRoute(
  app: AnyElysiaApp,
  method: 'get' | 'all',
  path: string,
  handler: (context: any) => unknown,
  hooks: Record<string, unknown>
): AnyElysiaApp {
  const register = app[method] as (...arguments_: any[]) => AnyElysiaApp
  return usesElysia2(app)
    ? register.call(app, path, hooks, handler)
    : register.call(app, path, handler, hooks)
}

const elysia1McpMacro = (options: McpRouteOptions) => ({
  introspect(hooks: Record<PropertyKey, unknown>) {
    const detail = hooks.detail as Record<string, unknown> | undefined
    // The hook merge gives child routes precedence over groups.
    // Guards without a callback copy only detail, so keep a JSON-invisible fallback.
    if (MCP_ROUTE_OPTIONS in hooks || (detail && MCP_ROUTE_DETAIL in detail)) return
    hooks[MCP_ROUTE_OPTIONS] = options
    const carrier = Object.assign(() => undefined, { [MCP_ROUTE_OPTIONS]: options })
    hooks.detail = { ...detail, [MCP_ROUTE_DETAIL]: carrier }
  }
})
const elysia2McpMacro = (options: McpRouteOptions) => ({
  introspect(hooks: Record<symbol, unknown>) {
    hooks[MCP_ROUTE_OPTIONS] = options
  }
})

const legacyMcpMacro = (options: McpRouteOptions) => {
  const carrier = Object.assign(() => undefined, { [MCP_ROUTE_OPTIONS]: options })
  return {
    detail: {
      [MCP_ROUTE_DETAIL]: carrier,
      // Early 1.4 cannot introspect local precedence. Retain every explicit denial.
      ...(options === false ? { [MCP_ROUTE_DENIED]: carrier } : {})
    }
  }
}

function hasV1Introspection(): boolean {
  if (supportsV1Introspection !== undefined) return supportsV1Introspection
  supportsV1Introspection = false
  const probe = new Elysia() as AnyElysiaApp
  probe.macro({
    mcpIntrospectionProbe: () => ({
      introspect() {
        supportsV1Introspection = true
      }
    })
  })
  registerAdapterRoute(probe, 'get', '/__mcp_probe', () => undefined, {
    mcpIntrospectionProbe: true
  })
  return supportsV1Introspection
}

export function installMcpMacro(app: AnyElysiaApp): AnyElysiaApp {
  const macro = usesElysia2(app)
    ? elysia2McpMacro
    : hasV1Introspection()
      ? elysia1McpMacro
      : legacyMcpMacro
  return app.macro({ mcp: macro }) as AnyElysiaApp
}
