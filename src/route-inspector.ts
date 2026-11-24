import {
  MCP_ROUTE_DENIED,
  MCP_ROUTE_DETAIL,
  MCP_ROUTE_OPTIONS,
  usesElysia2
} from './elysia-compat.js'
import type { AnyElysiaApp, McpRouteOperation, McpRouteOptions } from './types.js'

type ElysiaRoute = AnyElysiaApp['routes'][number]
const routeSchemaKeys = ['body', 'params', 'query', 'headers', 'cookie', 'response'] as const
const functionIds = new WeakMap<Function, number>()
let nextFunctionId = 0

export function listRouteOperations(app: AnyElysiaApp): McpRouteOperation[] {
  return getRoutes(app).map((route) => {
    const hooks = toRecord((route as { hooks?: unknown }).hooks)
    const rawDetail = toRecord(hooks.detail)
    const carrier = rawDetail[MCP_ROUTE_DETAIL]
    const detail = { ...rawDetail }
    delete detail[MCP_ROUTE_DETAIL]
    delete detail[MCP_ROUTE_DENIED]
    const captured =
      (hooks as Record<symbol, unknown>)[MCP_ROUTE_OPTIONS] ??
      (typeof carrier === 'function'
        ? (carrier as unknown as Record<symbol, unknown>)[MCP_ROUTE_OPTIONS]
        : undefined)
    const mcp = (
      MCP_ROUTE_DENIED in rawDetail ? false : captured === undefined ? hooks.mcp : captured
    ) as McpRouteOptions | undefined

    return {
      app,
      route,
      method: (route.method === '*' ? 'ALL' : route.method) as McpRouteOperation['method'],
      path: route.path,
      hooks,
      detail: Object.keys(detail).length > 0 ? detail : undefined,
      mcp
    }
  })
}

export function routeFingerprint(app: AnyElysiaApp, operations = listRouteOperations(app)): string {
  const elysia2 = usesElysia2(app)
  return operations
    .map((operation, index) => {
      if (!elysia2) {
        return `${index}:${operation.method}:${operation.path}:${stableStringify({
          mcp: operation.mcp,
          detail: operation.detail,
          schemaKeys: routeSchemaKeys.filter((key) => key in operation.hooks).join(',')
        })}`
      }
      const schemas = routeSchemaKeys
        .filter((key) => operation.hooks[key] !== undefined)
        .map((key) => [key, operation.hooks[key]])
      return `${index}:${operation.method}:${operation.path}:${stableStringify({
        mcp: operation.mcp,
        detail: operation.detail,
        schemas,
        layers: operation.hooks.schemas
      })}`
    })
    .join('|')
}

/** Elysia 2 keeps additive macro and standalone guard schemas in separate layers. */
export function routeSchemaSources(operation: McpRouteOperation, key: string): unknown[] {
  const sources = [operation.hooks[key]]
  const layers = operation.hooks.schemas
  if (Array.isArray(layers)) {
    for (const layer of layers) sources.push(toRecord(layer)[key])
  }
  return [...new Set(sources.filter((schema) => schema !== undefined))]
}

function getRoutes(app: AnyElysiaApp): ElysiaRoute[] {
  const directRoutes = (app as unknown as { routes?: ElysiaRoute[] }).routes
  if (Array.isArray(directRoutes)) return directRoutes

  const history = (app as unknown as { router?: { history?: ElysiaRoute[] } }).router?.history
  return Array.isArray(history) ? history : []
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function stableStringify(value: unknown, ancestors = new Set<object>()): string {
  if (value === null || value === undefined) return String(value)
  if (typeof value === 'function') {
    let id = functionIds.get(value)
    if (id === undefined) functionIds.set(value, (id = ++nextFunctionId))
    return `function:${id}`
  }
  if (typeof value !== 'object') return JSON.stringify(value) ?? String(value)
  if (ancestors.has(value)) return '[Circular]'
  ancestors.add(value)
  const serialized = Array.isArray(value)
    ? `[${value.map((item) => stableStringify(item, ancestors)).join(',')}]`
    : `{${Object.keys(value)
        .sort()
        .map(
          (key) =>
            `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key], ancestors)}`
        )
        .join(',')}}`
  ancestors.delete(value)
  return serialized
}
