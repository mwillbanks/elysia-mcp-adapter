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
  schemaPropertyAnnotation,
  schemaRequiredKeys
} from './normalize.js'
import { embedSchemaResource, isolateSchemaResources } from './resources.js'

type InputSlot = 'params' | 'query' | 'body'
type InputSource = InputSlot | 'input'
const routeInputSchemas = new WeakMap<
  McpRouteOperation,
  WeakMap<NormalizedMcpPluginOptions, Map<InputSource, JsonSchema | undefined>>
>()

/** Registry operations are snapshots; share their normalized slot layout with invocation. */
export function routeInputSchemaForSlot(
  operation: McpRouteOperation,
  slot: InputSource,
  options: NormalizedMcpPluginOptions
): JsonSchema | undefined {
  let byOptions = routeInputSchemas.get(operation)
  if (!byOptions) routeInputSchemas.set(operation, (byOptions = new WeakMap()))
  let schemas = byOptions.get(options)
  if (!schemas) byOptions.set(options, (schemas = new Map()))
  if (!schemas.has(slot)) {
    const schema =
      slot === 'input'
        ? normalizeRouteInputOverride(operation, 'tool', options)
        : normalizeRouteInputSchema(operation, 'tool', slot, options)
    schemas.set(slot, schema)
  }
  return schemas.get(slot)
}

/** The flat schema already closes the top-level object. Other whole-slot constraints need a wrapper. */
export function isFlattenedObjectSchema(
  schema: JsonSchema | undefined,
  preserveObjectConstraints = true
): boolean {
  return Boolean(
    schema &&
    (schema.type === 'object' || schema.properties) &&
    (!preserveObjectConstraints || canProjectProperties(schema))
  )
}

const projectedKeywords = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'allOf',
  '$id',
  '$schema',
  '$defs',
  'definitions',
  '$anchor',
  '$dynamicAnchor',
  '$comment',
  'title',
  'description',
  'default',
  'examples',
  'deprecated',
  'readOnly',
  'writeOnly'
])

function canProjectProperties(schema: JsonSchema): boolean {
  return (
    Object.keys(schema).every((key) => projectedKeywords.has(key)) &&
    (schema.type === undefined || schema.type === 'object') &&
    (schema.additionalProperties === undefined || schema.additionalProperties === false) &&
    (!Array.isArray(schema.allOf) ||
      schema.allOf.every(
        (layer) => layer === true || (isRecord(layer) && canProjectProperties(layer))
      ))
  )
}

type InputSchemas = Partial<Record<InputSlot, JsonSchema>>
const inputSlots: InputSlot[] = ['params', 'query', 'body']

/** Keep the legacy value key for a single wrapper when it is available. */
export function flatInputWrapperKeys(
  parts: InputSchemas,
  preserveObjectConstraints = true
): Partial<Record<InputSlot, string>> {
  const wrapped = inputSlots.filter(
    (slot) => parts[slot] && !isFlattenedObjectSchema(parts[slot], preserveObjectConstraints)
  )
  if (wrapped.length === 0) return {}
  const occupied = new Set(
    inputSlots
      .filter((slot) => !wrapped.includes(slot))
      .flatMap((slot) => Object.keys(objectSchemaProperties(parts[slot])))
  )
  return Object.fromEntries(
    wrapped.map((slot) => {
      let key = wrapped.length === 1 && !occupied.has('value') ? 'value' : slot
      while (occupied.has(key)) key = '$' + key
      occupied.add(key)
      return [slot, key]
    })
  )
}

export function composeRouteInputSchema(
  operation: McpRouteOperation,
  kind: McpRouteKind,
  options: NormalizedMcpPluginOptions
): JsonSchema {
  const routeMcp = operation.mcp === false ? undefined : operation.mcp

  const override =
    kind === 'tool' && options.inputMode === 'flatten'
      ? routeInputSchemaForSlot(operation, 'input', options)
      : normalizeRouteInputOverride(operation, kind, options)

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
    return flat ? isolateSchemaResources(flat) : emptyObjectSchema()
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

function normalizeRouteInputOverride(
  operation: McpRouteOperation,
  kind: McpRouteKind,
  options: NormalizedMcpPluginOptions
): JsonSchema | undefined {
  return normalizeJsonSchema(operation.mcp ? operation.mcp.inputSchema : undefined, {
    source: 'route',
    kind,
    route: operation,
    schemaLocation: 'input',
    options
  })
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
    allOf: schemas.map((schema, index) => {
      const layer =
        schema.additionalProperties === false
          ? { ...schema, properties: { ...properties, ...(schema.properties as object) } }
          : schema
      return embedSchemaResource(layer, `${slot}/layer-${index}`)
    })
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
  const args = Object.entries(properties).map(([name, property]) => ({
    name,
    title: schemaPropertyAnnotation(property, 'title'),
    description: schemaPropertyAnnotation(property, 'description'),
    required: required.has(name) || undefined
  }))

  return args.length > 0 ? args : undefined
}

function composeEnvelopeInputSchema(parts: InputSchemas): JsonSchema {
  const properties: Record<string, unknown> = {}
  const required: string[] = []

  for (const slot of inputSlots) {
    const schema = parts[slot]
    if (!schema) continue
    properties[slot] = embedSchemaResource(schema, slot)
    if (requiresEnvelopeSlot(slot, schema)) required.push(slot)
  }

  if (Object.keys(properties).length === 0) return emptyObjectSchema()

  return isolateSchemaResources({
    type: 'object',
    properties,
    required: required.length > 0 ? required : undefined,
    additionalProperties: false
  })
}

function requiresEnvelopeSlot(slot: InputSlot, schema: JsonSchema): boolean {
  return (
    slot === 'body' ||
    schemaRequiredKeys(schema).length > 0 ||
    (slot === 'params' && Object.keys(objectSchemaProperties(schema)).length > 0)
  )
}

function composeFlattenedInputSchema(parts: InputSchemas): JsonSchema {
  const properties: Record<string, unknown> = {}
  const required = new Set<string>()
  const definitions: Record<string, JsonSchema> = {}
  const wrappers = flatInputWrapperKeys(parts)

  for (const slot of inputSlots) {
    const schema = parts[slot]
    if (!schema) continue
    const wrapper = wrappers[slot]
    if (wrapper) {
      properties[wrapper] = embedSchemaResource(schema, slot)
      required.add(wrapper)
    } else {
      const referencePath = preserveFlatSchemaScope(schema, slot, definitions)
      addFlatProperties(properties, objectSchemaProperties(schema, referencePath))
      for (const key of schemaRequiredKeys(schema)) required.add(key)
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
  return isolateSchemaResources(result)
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

function preserveFlatSchemaScope(
  schema: JsonSchema,
  slot: string,
  definitions: Record<string, JsonSchema>
): string | undefined {
  if (!needsSchemaReferenceScope(schema)) return undefined
  // Keep property references in the original resource, including layer-local definitions.
  definitions[slot] = embedSchemaResource(schema, slot)
  return `#/$defs/${slot}`
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
