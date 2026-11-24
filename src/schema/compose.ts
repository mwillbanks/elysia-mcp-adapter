import { isRecord } from '../internal.js'
import { routeSchemaSources } from '../route-inspector.js'
import type {
  JsonSchema,
  McpRouteKind,
  McpRouteOperation,
  NormalizedMcpPluginOptions
} from '../types.js'
import {
  emptyObjectSchema,
  needsSchemaReferenceScope,
  normalizeJsonSchema,
  objectSchemaProperties,
  schemaRequiredKeys
} from './normalize.js'

type InputSlot = 'params' | 'query' | 'body'
const routeInputSchemas = new WeakMap<
  McpRouteOperation,
  WeakMap<NormalizedMcpPluginOptions, Map<InputSlot, JsonSchema | undefined>>
>()

/** Registry operations are snapshots; share their normalized slot layout with invocation. */
export function routeInputSchemaForSlot(
  operation: McpRouteOperation,
  slot: InputSlot,
  options: NormalizedMcpPluginOptions
): JsonSchema | undefined {
  let byOptions = routeInputSchemas.get(operation)
  if (!byOptions) routeInputSchemas.set(operation, (byOptions = new WeakMap()))
  let schemas = byOptions.get(options)
  if (!schemas) byOptions.set(options, (schemas = new Map()))
  if (!schemas.has(slot)) {
    schemas.set(slot, normalizeRouteInputSchema(operation, 'tool', slot, options))
  }
  return schemas.get(slot)
}

/** Preserve the advertised flat layout, including legacy properties-only schemas. */
export function isFlattenedObjectSchema(schema: JsonSchema | undefined): boolean {
  return schema?.type === 'object' || Boolean(schema?.properties)
}

export function composeRouteInputSchema(
  operation: McpRouteOperation,
  kind: McpRouteKind,
  options: NormalizedMcpPluginOptions
): JsonSchema {
  const routeMcp = operation.mcp === false ? undefined : operation.mcp

  const override = normalizeJsonSchema(routeMcp?.inputSchema, {
    source: 'route',
    kind,
    route: operation,
    schemaLocation: 'input',
    options
  })

  if (override) return override

  if (kind === 'prompt') {
    const promptArgs = normalizeJsonSchema(routeMcp?.prompt?.argsSchema, {
      source: 'route',
      kind,
      route: operation,
      schemaLocation: 'promptArgs',
      options
    })

    if (promptArgs) return promptArgs

    // Prompt arguments are flat key/value pairs mapped onto query (GET) or body
    // (otherwise) by invokeRoutePrompt, so the args schema mirrors that source.
    const flat = normalizeRouteInputSchema(
      operation,
      kind,
      operation.method === 'GET' ? 'query' : 'body',
      options,
      'promptArgs'
    )
    return flat ?? emptyObjectSchema()
  }

  const schemaForSlot = (slot: InputSlot) =>
    kind === 'tool' && options.inputMode === 'flatten'
      ? routeInputSchemaForSlot(operation, slot, options)
      : normalizeRouteInputSchema(operation, kind, slot, options)
  const params = schemaForSlot('params')
  const query = schemaForSlot('query')
  const body = schemaForSlot('body')
  if (options.inputMode === 'flatten') return composeFlattenedInputSchema({ params, query, body })

  return composeEnvelopeInputSchema({ params, query, body })
}

function normalizeRouteInputSchema(
  operation: McpRouteOperation,
  kind: McpRouteKind,
  slot: 'params' | 'query' | 'body',
  options: NormalizedMcpPluginOptions,
  schemaLocation: 'params' | 'query' | 'body' | 'promptArgs' = slot
): JsonSchema | undefined {
  const schemas = routeSchemaSources(operation, slot)
    .map((schema) =>
      normalizeJsonSchema(schema, {
        source: 'route',
        kind,
        route: operation,
        schemaLocation,
        options
      })
    )
    .filter((schema): schema is JsonSchema => schema !== undefined)
  if (schemas.length < 2) return schemas[0]
  // Elysia merges TypeBox object layers before validation. Admit sibling fields
  // in each closed layer while retaining its own constraints and reference scope.
  const properties = Object.fromEntries(
    schemas.flatMap((schema) => Object.keys(objectSchemaProperties(schema)).map((key) => [key, {}]))
  )
  return {
    ...(schemas.some((schema) => schema.type === 'object') ? { type: 'object' } : {}),
    allOf: schemas.map((schema) =>
      schema.additionalProperties === false
        ? { ...schema, properties: { ...properties, ...(schema.properties as object) } }
        : schema
    )
  }
}

export function composeRouteOutputSchema(
  operation: McpRouteOperation,
  kind: McpRouteKind,
  options: NormalizedMcpPluginOptions
): JsonSchema | undefined {
  const routeMcp = operation.mcp === false ? undefined : operation.mcp

  const override = normalizeJsonSchema(routeMcp?.outputSchema, {
    source: 'route',
    kind,
    route: operation,
    schemaLocation: 'output',
    options
  })

  if (override) return override

  // Elysia 2's public routes getter already merges schemas[].response in native order.
  // Reapplying those layers would change response-map override semantics.
  return normalizeResponseSchema(operation.hooks.response, operation, kind, options)
}

export function composeExplicitInputSchema(
  schema: unknown,
  kind: McpRouteKind,
  options: NormalizedMcpPluginOptions
): JsonSchema {
  return (
    normalizeJsonSchema(schema, {
      source: 'explicit',
      kind,
      schemaLocation: kind === 'prompt' ? 'promptArgs' : 'input',
      options
    }) ?? emptyObjectSchema()
  )
}

export function composeExplicitOutputSchema(
  schema: unknown,
  kind: McpRouteKind,
  options: NormalizedMcpPluginOptions
): JsonSchema | undefined {
  return normalizeJsonSchema(schema, {
    source: 'explicit',
    kind,
    schemaLocation: 'output',
    options
  })
}

export function promptArgumentsFromSchema(
  schema: JsonSchema | undefined
): Array<{ name: string; title?: string; description?: string; required?: boolean }> | undefined {
  if (!schema) return undefined

  const properties = objectSchemaProperties(schema)
  const required = new Set(schemaRequiredKeys(schema))
  const args = Object.entries(properties).map(([name, property]) => {
    const propertyRecord =
      property && typeof property === 'object' && !Array.isArray(property)
        ? (property as Record<string, unknown>)
        : {}

    return {
      name,
      title: typeof propertyRecord.title === 'string' ? propertyRecord.title : undefined,
      description:
        typeof propertyRecord.description === 'string' ? propertyRecord.description : undefined,
      required: required.has(name) || undefined
    }
  })

  return args.length > 0 ? args : undefined
}

function composeEnvelopeInputSchema(parts: {
  params?: JsonSchema
  query?: JsonSchema
  body?: JsonSchema
}): JsonSchema {
  const properties: Record<string, unknown> = {}
  const required: string[] = []

  if (parts.params) {
    properties.params = parts.params
    if (
      schemaRequiredKeys(parts.params).length > 0 ||
      Object.keys(objectSchemaProperties(parts.params)).length > 0
    ) {
      required.push('params')
    }
  }

  if (parts.query) {
    properties.query = parts.query
    if (schemaRequiredKeys(parts.query).length > 0) required.push('query')
  }

  if (parts.body) {
    properties.body = parts.body
    required.push('body')
  }

  if (Object.keys(properties).length === 0) return emptyObjectSchema()

  return {
    type: 'object',
    properties,
    required: required.length > 0 ? required : undefined,
    additionalProperties: false
  }
}

function composeFlattenedInputSchema(parts: {
  params?: JsonSchema
  query?: JsonSchema
  body?: JsonSchema
}): JsonSchema {
  const properties: Record<string, unknown> = {}
  const required = new Set<string>()
  const definitions: Record<string, JsonSchema> = {}

  for (const [slot, schema] of Object.entries(parts)) {
    if (!schema) continue

    if (isFlattenedObjectSchema(schema)) {
      const referencePath = preserveFlatSchemaScope(schema, slot, definitions)
      addFlatProperties(properties, objectSchemaProperties(schema, referencePath))
      for (const key of schemaRequiredKeys(schema)) required.add(key)
    } else {
      properties.value = needsSchemaReferenceScope(schema) ? scopeFlatSchema(schema, slot) : schema
      required.add('value')
    }
  }

  return finalizeFlatSchema(properties, required, definitions)
}

function finalizeFlatSchema(
  properties: Record<string, unknown>,
  required: Set<string>,
  definitions: Record<string, JsonSchema>
): JsonSchema {
  if (Object.keys(properties).length === 0) return emptyObjectSchema()

  const hasDefinitions = Object.keys(definitions).length > 0
  const result: JsonSchema = {
    type: 'object',
    ...(hasDefinitions ? { $defs: definitions } : {}),
    properties,
    required: required.size > 0 ? Array.from(required) : undefined,
    additionalProperties: false
  }
  return hasDefinitions || needsSchemaReferenceScope(properties.value)
    ? isolateFlatSchemaResources(result)
    : result
}

function addFlatProperties(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const [key, property] of Object.entries(source)) {
    Object.defineProperty(target, key, {
      value: property,
      enumerable: true,
      configurable: true,
      writable: true
    })
  }
}

const flatSchemaBase = 'https://elysia.internal/mcp/flat-input/'

function preserveFlatSchemaScope(
  schema: JsonSchema,
  slot: string,
  definitions: Record<string, JsonSchema>
): string | undefined {
  if (!needsSchemaReferenceScope(schema)) return undefined
  // Keep property references in the original resource, including layer-local definitions.
  definitions[slot] = scopeFlatSchema(schema, slot)
  return `#/$defs/${slot}`
}

function scopeFlatSchema(schema: JsonSchema, slot: string): JsonSchema {
  return typeof schema.$id === 'string' ? schema : { ...schema, $id: `${flatSchemaBase}${slot}/` }
}

const schemaMaps = new Set([
  '$defs',
  'definitions',
  'properties',
  'patternProperties',
  'dependentSchemas',
  'dependencies'
])
const schemaArrays = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems', 'items'])
const schemaValues = new Set([
  'items',
  'additionalItems',
  'unevaluatedItems',
  'contains',
  'additionalProperties',
  'unevaluatedProperties',
  'propertyNames',
  'not',
  'if',
  'then',
  'else',
  'contentSchema'
])

type VisitSchemaId = (declared: string, resolved: URL) => string | undefined

function isolateFlatSchemaResources(schema: JsonSchema): JsonSchema {
  const reserved = new Set<string>()
  let hasCopies = false
  mapFlatSchemaResources(schema, flatSchemaBase, (_declared, id) => {
    if (reserved.has(id.href)) hasCopies = true
    reserved.add(id.href)
    return undefined
  })
  if (!hasCopies) return schema

  const seen = new Set<string>()
  return mapFlatSchemaResources(schema, flatSchemaBase, (declared, id) =>
    renameFlatSchemaResourceCopy(declared, id, seen, reserved)
  )
}

function mapFlatSchemaResources(value: JsonSchema, base: string, visit: VisitSchemaId): JsonSchema {
  const declared = typeof value.$id === 'string' ? value.$id : undefined
  const id = declared === undefined ? null : URL.parse(declared, base)
  const replacement = declared !== undefined && id ? visit(declared, id) : undefined
  const resource = replacement === undefined ? value : { ...value, $id: replacement }
  const embed = (child: unknown): unknown =>
    isRecord(child) ? mapFlatSchemaResources(child, id?.href ?? base, visit) : child
  return Object.fromEntries(
    Object.entries(resource).map(([key, child]) => [key, embedFlatSchemaChild(key, child, embed)])
  )
}

function embedFlatSchemaChild(
  key: string,
  child: unknown,
  embed: (value: unknown) => unknown
): unknown {
  if (schemaArrays.has(key) && Array.isArray(child)) return child.map(embed)
  if (schemaMaps.has(key) && isRecord(child)) {
    return Object.fromEntries(Object.entries(child).map(([name, value]) => [name, embed(value)]))
  }
  return schemaValues.has(key) ? embed(child) : child
}

function renameFlatSchemaResourceCopy(
  declared: string,
  id: URL,
  seen: Set<string>,
  reserved: Set<string>
): string | undefined {
  if (!seen.has(id.href)) {
    seen.add(id.href)
    return undefined
  }

  // Preserve relative reference paths and leave the copy at its original JSON Pointer.
  // The first resource keeps the declared identifier for references from other slots.
  let index = seen.size
  do {
    id.searchParams.set('elysia-mcp-copy', String(index++))
  } while (reserved.has(id.href))
  reserved.add(id.href)
  return `${declared.split(/[?#]/, 1)[0]}${id.search}${id.hash}`
}

function normalizeResponseSchema(
  responseSchema: unknown,
  operation: McpRouteOperation,
  kind: McpRouteKind,
  options: NormalizedMcpPluginOptions
): JsonSchema | undefined {
  if (!responseSchema) return undefined

  const response = responseSchema as Record<string, unknown>

  if (response && typeof response === 'object' && !Array.isArray(response)) {
    if ('200' in response) {
      return normalizeJsonSchema(response['200'], {
        source: 'route',
        kind,
        route: operation,
        schemaLocation: 'output',
        options
      })
    }

    if (200 in response) {
      return normalizeJsonSchema(response[200], {
        source: 'route',
        kind,
        route: operation,
        schemaLocation: 'output',
        options
      })
    }
  }

  return normalizeJsonSchema(responseSchema, {
    source: 'route',
    kind,
    route: operation,
    schemaLocation: 'output',
    options
  })
}
