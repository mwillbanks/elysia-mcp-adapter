import type { InternalRoute } from 'elysia'
import type { AnyElysiaApp, McpRouteOperation, McpRouteOptions } from './types.js'

export function listRouteOperations(app: AnyElysiaApp): McpRouteOperation[] {
  const routes = getRoutes(app)

  return routes.map((route) => {
    const hooks = toRecord((route as { hooks?: unknown }).hooks)
    const detail = toRecord(hooks.detail)
    const mcp = hooks.mcp as McpRouteOptions | undefined

    return {
      app,
      route,
      method: route.method,
      path: route.path,
      hooks,
      detail: detail && Object.keys(detail).length > 0 ? detail : undefined,
      mcp
    }
  })
}

export function routeFingerprint(app: AnyElysiaApp): string {
  const routes = getRoutes(app)
  return routes
    .map(
      (route, index) => `${index}:${route.method}:${route.path}:${fingerprintHooks(route.hooks)}`
    )
    .join('|')
}

function getRoutes(app: AnyElysiaApp): InternalRoute[] {
  const directRoutes = (app as unknown as { routes?: InternalRoute[] }).routes
  if (Array.isArray(directRoutes)) return directRoutes

  const history = (app as unknown as { router?: { history?: InternalRoute[] } }).router?.history
  if (Array.isArray(history)) return history

  return []
}

function toRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }

  return {}
}

function fingerprintHooks(hooks: unknown): string {
  if (!hooks || typeof hooks !== 'object') return ''

  const hookRecord = hooks as Record<string, unknown>
  const mcp = hookRecord.mcp
  const detail = hookRecord.detail
  const schemaKeys = ['body', 'params', 'query', 'headers', 'cookie', 'response']
    .filter((key) => key in hookRecord)
    .join(',')

  return stableStringify({ mcp, detail, schemaKeys })
}

function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return String(value)
  if (typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`

  const record = value as Record<string, unknown>
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(',')}}`
}
