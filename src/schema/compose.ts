import { routeSchemaSources } from '../route-inspector.js'
import type {
  JsonSchema,
  McpRouteKind,
  McpRouteOperation,
  NormalizedMcpPluginOptions
} from '../types.js'
import {
  emptyObjectSchema,
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
    ...(schemas.some(requiresObject) ? { type: 'object' } : {}),
    allOf: schemas.map((schema) =>
      schema.additionalProperties === false
        ? { ...schema, properties: { ...properties, ...(schema.properties as object) } }
        : schema
    )
  }
}

function requiresObject(schema: JsonSchema): boolean {
  return (
    schema.type === 'object' ||
    (Array.isArray(schema.allOf) &&
      schema.allOf.some(
        (branch) =>
          branch !== null &&
          typeof branch === 'object' &&
          !Array.isArray(branch) &&
          requiresObject(branch as JsonSchema)
      ))
  )
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

  for (const schema of [parts.params, parts.query, parts.body]) {
    if (!schema) continue

    if (isFlattenedObjectSchema(schema)) {
      for (const [key, property] of Object.entries(objectSchemaProperties(schema))) {
        Object.defineProperty(properties, key, {
          value: property,
          enumerable: true,
          configurable: true,
          writable: true
        })
      }
      for (const key of schemaRequiredKeys(schema)) required.add(key)
    } else {
      properties.value = schema
      required.add('value')
    }
  }

  if (Object.keys(properties).length === 0) return emptyObjectSchema()

  return {
    type: 'object',
    properties,
    required: required.size > 0 ? Array.from(required) : undefined,
    additionalProperties: false
  }
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
