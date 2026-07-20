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
    const source = operation.method === 'GET' ? operation.hooks.query : operation.hooks.body
    const flat = normalizeJsonSchema(source, {
      source: 'route',
      kind,
      route: operation,
      schemaLocation: 'promptArgs',
      options
    })

    return flat ?? emptyObjectSchema()
  }

  const params = normalizeJsonSchema(operation.hooks.params, {
    source: 'route',
    kind,
    route: operation,
    schemaLocation: 'params',
    options
  })
  const query = normalizeJsonSchema(operation.hooks.query, {
    source: 'route',
    kind,
    route: operation,
    schemaLocation: 'query',
    options
  })
  const body = normalizeJsonSchema(operation.hooks.body, {
    source: 'route',
    kind,
    route: operation,
    schemaLocation: 'body',
    options
  })

  if (options.inputMode === 'flatten') return composeFlattenedInputSchema({ params, query, body })

  return composeEnvelopeInputSchema({ params, query, body })
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

    if (schema.type === 'object' || schema.properties) {
      Object.assign(properties, objectSchemaProperties(schema))
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
