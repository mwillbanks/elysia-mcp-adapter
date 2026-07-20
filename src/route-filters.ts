import { INTERNAL_EXCLUDED_ROUTES } from './constants.js'
import type { McpRouteMatcher, McpRouteOperation, NormalizedMcpPluginOptions } from './types.js'

export function shouldExposeRoute(
  operation: McpRouteOperation,
  options: NormalizedMcpPluginOptions
): boolean {
  const routeMcp = operation.mcp

  if (routeMcp === false) return false
  if (routeMcp && routeMcp.expose === false) return false

  if (!options.methods.includes(operation.method)) return false

  if (!options.includeHiddenRoutes && operation.detail?.hide === true) return false

  if (matchesAny(operation, INTERNAL_EXCLUDED_ROUTES)) return false

  if (options.allowedRoutes === '*') {
    return !matchesAny(operation, options.excludedRoutes)
  }

  return matchesAny(operation, options.allowedRoutes)
}

function matchesAny(operation: McpRouteOperation, matchers: readonly McpRouteMatcher[]): boolean {
  return matchers.some((matcher) => matchesRoute(operation, matcher))
}

function matchesRoute(operation: McpRouteOperation, matcher: McpRouteMatcher): boolean {
  if (typeof matcher === 'string') return matchPath(operation.path, matcher)
  if (matcher instanceof RegExp) return matcher.test(operation.path)

  if (matcher.method) {
    const methods = Array.isArray(matcher.method) ? matcher.method : [matcher.method]
    if (!methods.includes(operation.method)) return false
  }

  if (typeof matcher.path === 'string') return matchPath(operation.path, matcher.path)
  return matcher.path.test(operation.path)
}

function matchPath(path: string, pattern: string): boolean {
  if (pattern === '*') return true
  if (pattern === path) return true

  if (pattern.endsWith('/*')) {
    const prefix = pattern.slice(0, -1)
    return path.startsWith(prefix)
  }

  if (pattern.includes('*')) {
    const escaped = pattern
      .split('*')
      .map((part) => escapeRegExp(part))
      .join('.*')

    return new RegExp(`^${escaped}$`).test(path)
  }

  return false
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
