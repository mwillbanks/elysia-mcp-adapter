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

const v1RegistrationBoundaries = new WeakSet<AnyElysiaApp>()

function freshV1Hooks(value: unknown): unknown {
  if (!value || typeof value !== 'object' || !Object.hasOwn(value, 'mcp')) return value
  const hooks = value as Record<PropertyKey, unknown>
  const detail = hooks.detail as Record<string, unknown> | undefined
  if (!(MCP_ROUTE_OPTIONS in hooks) && !(detail && MCP_ROUTE_DETAIL in detail)) return value
  const fresh = { ...hooks }
  delete fresh[MCP_ROUTE_OPTIONS]
  if (detail) {
    const freshDetail = { ...detail }
    delete freshDetail[MCP_ROUTE_DETAIL]
    delete freshDetail[MCP_ROUTE_DENIED]
    fresh.detail = freshDetail
  }
  return fresh
}

function wrapV1Scope(app: AnyElysiaApp, method: 'group' | 'guard'): void {
  const original = app[method] as (...arguments_: any[]) => any
  Object.defineProperty(app, method, {
    configurable: true,
    writable: true,
    value: function (this: AnyElysiaApp, ...arguments_: any[]) {
      const callbackIndex = arguments_.length - 1
      const callback = arguments_[callbackIndex]
      const hookIndex = method === 'group' ? 1 : 0
      if (typeof arguments_[hookIndex] !== 'function') {
        arguments_[hookIndex] = freshV1Hooks(arguments_[hookIndex])
      }
      if (typeof callback === 'function') {
        arguments_[callbackIndex] = function (this: unknown, child: AnyElysiaApp) {
          installV1RegistrationBoundary(child)
          return callback.call(this, child)
        }
      }
      return original.apply(this, arguments_)
    }
  })
}

function installV1RegistrationBoundary(app: AnyElysiaApp): void {
  if (v1RegistrationBoundaries.has(app)) return
  v1RegistrationBoundaries.add(app)
  // Native group/guard replay calls add() directly. Only public declarations
  // discard copied captures, so replay retains child-route precedence.
  const methods = [
    'get',
    'post',
    'put',
    'patch',
    'delete',
    'options',
    'all',
    'head',
    'connect',
    'route',
    'ws'
  ] as const
  for (const method of methods) {
    const original = app[method] as (...arguments_: any[]) => any
    const hookIndex = method === 'route' ? 3 : method === 'ws' ? 1 : 2
    Object.defineProperty(app, method, {
      configurable: true,
      writable: true,
      value: function (this: AnyElysiaApp, ...arguments_: any[]) {
        arguments_[hookIndex] = freshV1Hooks(arguments_[hookIndex])
        return original.apply(this, arguments_)
      }
    })
  }
  wrapV1Scope(app, 'group')
  wrapV1Scope(app, 'guard')
}

export function installMcpMacro(app: AnyElysiaApp): AnyElysiaApp {
  const macro = usesElysia2(app)
    ? elysia2McpMacro
    : hasV1Introspection()
      ? elysia1McpMacro
      : legacyMcpMacro
  if (macro === elysia1McpMacro) installV1RegistrationBoundary(app)
  return app.macro({ mcp: macro }) as AnyElysiaApp
}
