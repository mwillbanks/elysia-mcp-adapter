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
      'input' | 'output' | 'params' | 'query' | 'body' | 'headers' | 'cookie' | 'promptArgs'
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
  return Object.fromEntries(
    Object.entries(value)
      .map(([key, item]) => [key, cloneJsonSchema(item)])
      .filter(([, item]) => item !== undefined)
  )
}

export function emptyObjectSchema(): JsonSchema {
  return { ...JSON_SCHEMA_EMPTY_OBJECT }
}

export function schemaRequiredKeys(schema: JsonSchema | undefined): string[] {
  const required = Array.isArray(schema?.required)
    ? schema.required.filter((value): value is string => typeof value === 'string')
    : []
  for (const [, child] of allOfSchemas(schema)) required.push(...schemaRequiredKeys(child))
  return [...new Set(required)]
}

export function objectSchemaProperties(
  schema: JsonSchema | undefined,
  referencePath?: string
): Record<string, unknown> {
  const result = ownSchemaProperties(schema, referencePath)
  for (const [index, child] of allOfSchemas(schema)) {
    const childPath = referencePath && `${referencePath}/allOf/${index}`
    for (const [key, property] of Object.entries(objectSchemaProperties(child, childPath))) {
      Object.defineProperty(result, key, {
        value: Object.hasOwn(result, key) ? { allOf: [result[key], property] } : property,
        enumerable: true,
        configurable: true,
        writable: true
      })
    }
  }
  return result
}

function ownSchemaProperties(
  schema: JsonSchema | undefined,
  referencePath: string | undefined
): Record<string, unknown> {
  const properties = schema?.properties
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) return {}
  if (!referencePath) return { ...(properties as Record<string, unknown>) }
  return Object.fromEntries(
    Object.keys(properties).map((key) => {
      const pointer = encodeURIComponent(key.replaceAll('~', '~0').replaceAll('/', '~1'))
      return [key, { $ref: `${referencePath}/properties/${pointer}` }]
    })
  )
}

function allOfSchemas(schema: JsonSchema | undefined): Array<[number, JsonSchema]> {
  if (!Array.isArray(schema?.allOf)) return []
  return Array.from(schema.allOf.entries()).filter(
    (entry): entry is [number, JsonSchema] =>
      entry[1] !== null && typeof entry[1] === 'object' && !Array.isArray(entry[1])
  )
}

export function needsSchemaReferenceScope(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false
  return (
    ('$id' in value && typeof value.$id === 'string') ||
    ('$ref' in value && typeof value.$ref === 'string') ||
    ('$dynamicRef' in value && typeof value.$dynamicRef === 'string') ||
    Object.values(value).some(needsSchemaReferenceScope)
  )
}
