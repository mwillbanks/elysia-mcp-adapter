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
  if (isJsonPrimitive(value)) return value
  if (unsupportedJsonType(value)) return undefined
  if (Array.isArray(value)) return cloneArray(value)
  if (value instanceof Date) return value.toISOString()
  return typeof value === 'object' ? cloneRecord(value as Record<string, unknown>) : undefined
}

function isJsonPrimitive(value: unknown): boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
}

function unsupportedJsonType(value: unknown): boolean {
  return ['undefined', 'function', 'symbol', 'bigint'].includes(typeof value)
}

function cloneArray(value: readonly unknown[]): unknown[] {
  const result: unknown[] = []
  for (const item of value) {
    const cloned = cloneJsonSchema(item)
    if (cloned !== undefined) result.push(cloned)
  }
  return result
}

function cloneRecord(value: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const key of Object.keys(value)) {
    const cloned = cloneJsonSchema(value[key])
    if (cloned !== undefined) result[key] = cloned
  }
  return result
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
