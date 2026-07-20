import type { McpRouteOperation } from './types.js'

const MCP_NAME_PATTERN = /[^A-Za-z0-9_.-]+/g

export function sanitizeMcpName(input: string): string {
  const normalized = input
    .trim()
    .replace(MCP_NAME_PATTERN, '_')
    .replace(/_{2,}/g, '_')
    .replace(/\.{2,}/g, '.')
    .replace(/^[_.-]+/, '')
    .replace(/[_.-]+$/, '')

  const safe = normalized.length > 0 ? normalized : 'operation'
  return safe.slice(0, 128)
}

function pathToOperationSegments(path: string): string[] {
  if (path === '/' || path.length === 0) return ['index']

  return path
    .split('/')
    .filter(Boolean)
    .map((segment) => {
      if (segment === '*') return 'wildcard'
      if (segment.startsWith(':')) return `by_${segment.slice(1)}`
      if (segment.startsWith('{') && segment.endsWith('}')) return `by_${segment.slice(1, -1)}`
      return segment
    })
    .map((segment) => sanitizeMcpName(segment))
    .filter(Boolean)
}

export function defaultOperationNameResolver(operation: McpRouteOperation): string {
  const operationId = operation.detail?.operationId

  if (typeof operationId === 'string' && operationId.trim()) {
    return sanitizeMcpName(operationId)
  }

  return sanitizeMcpName(
    `${operation.method.toLowerCase()}.${pathToOperationSegments(operation.path).join('.')}`
  )
}

export function humanizeOperationName(name: string): string {
  return name.replace(/[_.-]+/g, ' ').replace(/\b\w/g, (value) => value.toUpperCase())
}
