import { JSON_SCHEMA_EMPTY_OBJECT } from '../constants.js'
import type {
  JsonSchema,
  McpRouteKind,
  McpRouteOperation,
  NormalizedMcpPluginOptions
} from '../types.js'

export function normalizeJsonSchema(
  schema: unknown,
  context: {
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
    options: NormalizedMcpPluginOptions
  }
): JsonSchema | undefined {
  if (!schema) return undefined

  const mapped = context.options.mapJsonSchema
    ? context.options.mapJsonSchema(schema, {
        source: context.source,
        kind: context.kind,
        route: context.route,
        schemaLocation: context.schemaLocation
      })
    : schema

  const cloned = cloneJsonSchema(mapped)

  if (!cloned || typeof cloned !== 'object' || Array.isArray(cloned)) return undefined

  return cloned as JsonSchema
}

function cloneJsonSchema(value: unknown): unknown {
  if (value === null) return null

  const type = typeof value
  if (type === 'string' || type === 'number' || type === 'boolean') return value
  if (type === 'undefined' || type === 'function' || type === 'symbol' || type === 'bigint')
    return undefined

  if (Array.isArray(value)) {
    const result: unknown[] = []
    for (const item of value) {
      const cloned = cloneJsonSchema(item)
      if (cloned !== undefined) result.push(cloned)
    }
    return result
  }

  if (value instanceof Date) return value.toISOString()

  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    const result: Record<string, unknown> = {}

    for (const key of Object.keys(record)) {
      const cloned = cloneJsonSchema(record[key])
      if (cloned !== undefined) result[key] = cloned
    }

    return result
  }

  return undefined
}

export function emptyObjectSchema(): JsonSchema {
  return { ...JSON_SCHEMA_EMPTY_OBJECT }
}

export function schemaRequiredKeys(schema: JsonSchema | undefined): string[] {
  const required = schema?.required
  return Array.isArray(required)
    ? required.filter((value): value is string => typeof value === 'string')
    : []
}

export function objectSchemaProperties(schema: JsonSchema | undefined): Record<string, unknown> {
  const properties = schema?.properties
  if (properties && typeof properties === 'object' && !Array.isArray(properties)) {
    return properties as Record<string, unknown>
  }

  return {}
}
