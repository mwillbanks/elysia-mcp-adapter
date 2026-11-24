import { expect, test } from 'bun:test'
import { normalizeRouteToolInput } from '../src/invoke/build-request.js'
import { normalizeOptions } from '../src/options.js'
import { getMcpRegistry } from '../src/registry.js'
import {
  composeRouteInputSchema,
  isFlattenedObjectSchema,
  routeInputSchemaForSlot,
  promptArgumentsFromSchema
} from '../src/schema/compose.js'
import { normalizeJsonSchema, objectSchemaProperties } from '../src/schema/normalize.js'
import { validateJsonSchema } from '../src/schema/validate.js'
import type { AnyElysiaApp, JsonSchema, McpRouteOperation } from '../src/types.js'

function operation(hooks: Record<string, unknown>): McpRouteOperation {
  const route = { method: 'GET', path: '/layers', hooks }
  const app = { routes: [route] } as unknown as AnyElysiaApp
  return { app, route: route as McpRouteOperation['route'], method: 'GET', path: route.path, hooks }
}

function layeredSchema(direct: JsonSchema, inherited: JsonSchema): JsonSchema {
  return composeRouteInputSchema(
    operation({ query: direct, schemas: [{ query: inherited }] }),
    'tool',
    normalizeOptions()
  )
}

test('composes closed object layers without rejecting sibling properties', () => {
  const schema = layeredSchema(
    {
      type: 'object',
      properties: { direct: { type: 'string', minLength: 2 } },
      required: ['direct'],
      additionalProperties: false
    },
    {
      type: 'object',
      properties: { inherited: { type: 'string', pattern: '^ok' } },
      required: ['inherited'],
      additionalProperties: false
    }
  )
  expect(validateJsonSchema(schema, { query: { direct: 'yes', inherited: 'okay' } }).ok).toBe(true)
  for (const query of [
    { direct: 'yes' },
    { inherited: 'okay' },
    { direct: 'x', inherited: 'okay' },
    { direct: 'yes', inherited: 'no' },
    { direct: 'yes', inherited: 'okay', extra: 'denied' }
  ]) {
    expect(validateJsonSchema(schema, { query }).ok).toBe(false)
  }
})

test('retains overlapping constraints and layer reference scopes', () => {
  const direct = {
    $id: 'https://example.test/direct-layer',
    $defs: { value: { type: 'string', minLength: 3 } },
    type: 'object',
    properties: { value: { $ref: '#/$defs/value' }, direct: { type: 'boolean' } },
    required: ['value', 'direct'],
    additionalProperties: false
  }
  const inherited = {
    $id: 'https://example.test/inherited-layer',
    $defs: { value: { type: 'string', pattern: '^a' } },
    type: 'object',
    properties: { value: { $ref: '#/$defs/value' }, inherited: { type: 'boolean' } },
    required: ['value', 'inherited'],
    additionalProperties: false
  }
  const envelope = layeredSchema(direct, inherited)
  const flat = composeRouteInputSchema(
    operation({ query: direct, schemas: [{ query: inherited }] }),
    'tool',
    normalizeOptions({ inputMode: 'flatten' })
  )
  const fields = { value: 'abc', direct: true, inherited: true }
  expect(validateJsonSchema(envelope, { query: fields }).ok).toBe(true)
  expect(validateJsonSchema(flat, fields).ok).toBe(true)
  for (const value of ['ab', 'xyz']) {
    const invalid = { ...fields, value }
    expect(validateJsonSchema(envelope, { query: invalid }).ok).toBe(false)
    expect(validateJsonSchema(flat, invalid).ok).toBe(false)
  }
})

test('keeps independent anonymous layer references in every route input shape', () => {
  const sources = [{ minLength: 3 }, { pattern: '^a' }].map((constraint) => ({
    type: 'object',
    $defs: { term: { type: 'string', ...constraint } },
    properties: { term: { $ref: '#/$defs/term' } },
    required: ['term']
  }))
  const route = operation({ query: sources[0], schemas: [{ query: sources[1] }] })
  for (const [kind, options] of [
    ['tool', normalizeOptions()],
    ['tool', normalizeOptions({ inputMode: 'flatten' })],
    ['prompt', normalizeOptions()]
  ] as const) {
    const schema = composeRouteInputSchema(route, kind, options)
    const input = (term: string) =>
      kind === 'tool' && options.inputMode === 'envelope' ? { query: { term } } : { term }
    expect(validateJsonSchema(schema, input('abc'))).toEqual({ ok: true })
    for (const term of ['ab', 'xyz']) expect(validateJsonSchema(schema, input(term)).ok).toBe(false)
  }
})

test('keeps named self references and canonical empty fragments separate from cross-slot references', () => {
  const id = 'https://example.test/alias-resource.json'
  const query = {
    $id: id,
    type: 'object',
    $defs: { term: { type: 'string' } },
    properties: { name: { $ref: '#/$defs/term' } },
    required: ['name']
  }
  const body = {
    $id: id + '#',
    type: 'object',
    $defs: { term: { type: 'number' } },
    properties: { count: { $ref: 'alias-resource.json#/$defs/term' } },
    required: ['count']
  }
  const params = {
    type: 'object',
    properties: { original: { $ref: id + '#/$defs/term' } }
  }
  const schema = composeRouteInputSchema(
    operation({ params, query, body }),
    'tool',
    normalizeOptions({ inputMode: 'flatten' })
  )
  const input = { name: 'abc', count: 3, original: 'abc' }
  expect(validateJsonSchema(schema, input)).toEqual({ ok: true })
  expect(validateJsonSchema(schema, { ...input, count: 'abc' }).ok).toBe(false)
  expect(validateJsonSchema(schema, { ...input, original: 3 }).ok).toBe(false)
})

test('rebases a copied resource’s references to its own named descendants', () => {
  const slot = (name: string, type: string) => ({
    $id: 'https://test.example/parent.json',
    $defs: { child: { $id: 'child.json', type } },
    type: 'object',
    properties: { [name]: { $ref: 'child.json' } }
  })
  const route = operation({ query: slot('text', 'string'), body: slot('count', 'number') })
  const schema = composeRouteInputSchema(route, 'tool', normalizeOptions({ inputMode: 'flatten' }))
  expect(validateJsonSchema(schema, { text: 'abc', count: 3 })).toEqual({ ok: true })
  expect(validateJsonSchema(schema, { text: 'abc', count: 'abc' }).ok).toBe(false)
  expect(validateJsonSchema(schema, { text: 3, count: 3 }).ok).toBe(false)
})

test('keeps references from relative copies to distinct relative resources', () => {
  const slot = (name: string) => ({
    $id: 'shared.json',
    type: 'object',
    properties: { [name]: { $ref: 'external.json#/$defs/field' } }
  })
  const route = operation({
    params: {
      $id: 'external.json',
      type: 'object',
      $defs: { field: { type: 'string' } }
    },
    query: slot('first'),
    body: slot('second')
  })
  const schema = composeRouteInputSchema(route, 'tool', normalizeOptions({ inputMode: 'flatten' }))
  expect(validateJsonSchema(schema, { first: 'abc', second: 'def' })).toEqual({ ok: true })
  expect(validateJsonSchema(schema, { first: 'abc', second: 3 }).ok).toBe(false)
})

test('compiles independent schemas with reused identifiers without advertising them globally', () => {
  const id = 'https://example.test/independent-validator'
  expect(validateJsonSchema({ $id: id, type: 'string' }, 'abc')).toEqual({ ok: true })
  expect(validateJsonSchema({ $id: id, type: 'number' }, 3)).toEqual({ ok: true })
  expect(validateJsonSchema({ $ref: id }, 'abc').ok).toBe(false)
})

test('preserves layered prompt annotations and their property constraints', () => {
  const route = operation({
    query: {
      type: 'object',
      additionalProperties: false,
      properties: { q: { type: 'string', title: 'Search', minLength: 2 } },
      required: ['q']
    },
    schemas: [
      {
        query: {
          type: 'object',
          additionalProperties: false,
          properties: { locale: { type: 'string' } }
        }
      },
      {
        query: {
          type: 'object',
          properties: { q: { title: 'Fallback', description: 'Search term', pattern: '^a' } }
        }
      }
    ]
  })
  const schema = composeRouteInputSchema(route, 'prompt', normalizeOptions())
  expect(promptArgumentsFromSchema(schema)).toContainEqual({
    name: 'q',
    title: 'Search',
    description: 'Search term',
    required: true
  })
  expect(validateJsonSchema(schema, { q: 'abc' })).toEqual({ ok: true })
  for (const q of ['a', 'zbc']) expect(validateJsonSchema(schema, { q }).ok).toBe(false)
})

test('reads annotations from an allOf property in an explicit prompt schema', () => {
  const schema = {
    properties: {
      q: { title: 'Search', allOf: [{ title: 'Fallback', description: 'Search term' }] }
    }
  }
  expect(promptArgumentsFromSchema(schema)).toContainEqual({
    name: 'q',
    title: 'Search',
    description: 'Search term'
  })
})

test('keeps wrapped slots distinct from flat fields and uses the same layout for dispatch', () => {
  const route = operation({
    params: { type: 'object', properties: { value: { type: 'string' } } },
    query: { type: 'object', properties: { term: { type: 'string' } }, maxProperties: 1 },
    body: { type: 'object', properties: { count: { type: 'number' } }, minProperties: 1 }
  })
  route.path = '/layers/:value'
  const options = normalizeOptions({ inputMode: 'flatten' })
  const schema = composeRouteInputSchema(route, 'tool', options)
  const input = { value: 'path', query: { term: 'abc' }, body: { count: 3 } }
  expect(validateJsonSchema(schema, input)).toEqual({ ok: true })
  expect(validateJsonSchema(schema, { ...input, query: { term: 'abc', extra: true } }).ok).toBe(
    false
  )
  expect(normalizeRouteToolInput(input, route, options)).toEqual({
    params: { value: 'path' },
    query: input.query,
    body: input.body
  })
})

test('retains explicitly allowed extra properties in flattened input', () => {
  const route = operation({
    query: {
      type: 'object',
      properties: { term: { type: 'string' } },
      additionalProperties: true
    }
  })
  const options = normalizeOptions({ inputMode: 'flatten' })
  const input = { value: { term: 'abc', extra: 'also allowed' } }
  const schema = composeRouteInputSchema(route, 'tool', options)
  expect(validateJsonSchema(schema, input)).toEqual({ ok: true })
  expect(normalizeRouteToolInput(input, route, options).query).toEqual(input.value)
})

test('keeps the flat invocation layout selected by an explicit input schema', () => {
  const route = operation({
    query: { type: 'object', properties: { term: { type: 'string' } } },
    body: { type: 'object', properties: { count: { type: 'number' } }, maxProperties: 1 }
  })
  const inputSchema = {
    type: 'object',
    properties: { term: { type: 'string' }, count: { type: 'number' } }
  }
  route.mcp = { inputSchema }
  const options = normalizeOptions({ inputMode: 'flatten' })
  const input = { term: 'abc', count: 3 }
  expect(composeRouteInputSchema(route, 'tool', options)).toEqual(inputSchema)
  expect(normalizeRouteToolInput(input, route, options)).toEqual({
    params: undefined,
    query: { term: 'abc' },
    body: { count: 3 }
  })

  const inferred = normalizeOptions({
    inputMode: 'flatten',
    mapJsonSchema: (schema, context) => (context.schemaLocation === 'input' ? undefined : schema)
  })
  const wrapped = { term: 'abc', value: { count: 3 } }
  expect(validateJsonSchema(composeRouteInputSchema(route, 'tool', inferred), wrapped).ok).toBe(
    true
  )
  expect(normalizeRouteToolInput(wrapped, route, inferred)).toEqual({
    params: undefined,
    query: { term: 'abc' },
    body: { count: 3 }
  })
})

test('preserves local references without an explicit id and encodes projected property pointers', () => {
  const key = 'path/item ~ label'
  const body = {
    type: 'object',
    $defs: { value: { type: 'string', minLength: 3 } },
    properties: { [key]: { $ref: '#/$defs/value' } },
    required: [key]
  }
  const schema = composeRouteInputSchema(
    operation({ body }),
    'tool',
    normalizeOptions({ inputMode: 'flatten' })
  )
  expect(validateJsonSchema(schema, { [key]: 'okay' }).ok).toBe(true)
  expect(validateJsonSchema(schema, { [key]: 'no' }).ok).toBe(false)
})

test('shares identical named reference resources across flattened slots', () => {
  const shared = {
    type: 'object',
    $id: 'https://example.test/shared-slot',
    $defs: { value: { type: 'string', minLength: 3 } },
    properties: { value: { $ref: '#/$defs/value' } },
    required: ['value']
  }
  const extra = { type: 'object', properties: { page: { type: 'string' } } }
  for (const hooks of [
    { query: shared, body: shared },
    { query: shared, body: shared, schemas: [{ query: extra }] },
    { query: shared, body: shared, schemas: [{ body: extra }] },
    { query: shared, body: shared, schemas: [{ query: extra, body: extra }] }
  ]) {
    const schema = composeRouteInputSchema(
      operation(hooks),
      'tool',
      normalizeOptions({ inputMode: 'flatten' })
    )
    expect(validateJsonSchema(schema, { value: 'okay' }).ok).toBe(true)
    expect(validateJsonSchema(schema, { value: 'no' }).ok).toBe(false)
  }
})

test('reserves declared identifiers before allocating repeated resource IDs', () => {
  const id = 'https://example.test/duplicate'
  const named = { $id: id, type: 'string', minLength: 3 }
  const target = { $id: `${id}?elysia-mcp-copy=2`, type: 'number', minimum: 3 }
  const query = {
    $id: 'https://example.test/query',
    type: 'object',
    $defs: { first: named, second: named, target },
    properties: { count: { $ref: target.$id } },
    required: ['count']
  }
  const schema = composeRouteInputSchema(
    operation({ query }),
    'tool',
    normalizeOptions({ inputMode: 'flatten' })
  )
  expect(validateJsonSchema(schema, { count: 3 }).ok).toBe(true)
  expect(validateJsonSchema(schema, { count: 'okay' }).ok).toBe(false)
})

test('isolates resources shared by object and value slots in the same input', () => {
  const shared = { $id: 'https://example.test/shared-value', type: 'string', minLength: 3 }
  const query = {
    type: 'object',
    $defs: { name: shared },
    properties: { name: { $ref: shared.$id } },
    required: ['name']
  }
  const body = { anyOf: [shared, { type: 'number' }] }
  const schema = composeRouteInputSchema(
    operation({ query, body }),
    'tool',
    normalizeOptions({ inputMode: 'flatten' })
  )
  expect(validateJsonSchema(schema, { name: 'okay', value: 'okay' }).ok).toBe(true)
  expect(validateJsonSchema(schema, { name: 'okay', value: 3 }).ok).toBe(true)
  expect(validateJsonSchema(schema, { name: 'okay', value: 'no' }).ok).toBe(false)
})

test('retains separate local scopes for repeated relative resource IDs', () => {
  const query = {
    $id: 'shared.json',
    type: 'object',
    $defs: { value: { type: 'string', minLength: 3 } },
    properties: { name: { $ref: '#/$defs/value' } },
    required: ['name']
  }
  const body = {
    $id: 'shared.json',
    type: 'object',
    $defs: { value: { type: 'number', minimum: 3 } },
    properties: { count: { $ref: 'shared.json#/$defs/value' } },
    required: ['count']
  }
  const schema = composeRouteInputSchema(
    operation({ query, body }),
    'tool',
    normalizeOptions({ inputMode: 'flatten' })
  )
  expect(validateJsonSchema(schema, { name: 'okay', count: 3 }).ok).toBe(true)
  expect(validateJsonSchema(schema, { name: 'okay', count: 2 }).ok).toBe(false)
  expect(validateJsonSchema(schema, { name: 'no', count: 3 }).ok).toBe(false)
})

test('preserves local pointers through multiple nested shared resources', () => {
  const leaf = {
    $id: 'https://example.test/leaf',
    type: 'object',
    $defs: { name: { type: 'string', minLength: 3 } },
    properties: { name: { $ref: '#/$defs/name' } },
    required: ['name']
  }
  const parent = { $id: 'https://example.test/parent', type: 'object', allOf: [leaf] }
  const query = {
    type: 'object',
    $defs: { leaf },
    allOf: [parent],
    properties: { copy: { $ref: '#/allOf/0/allOf/0/properties/name' } },
    required: ['copy']
  }
  const schema = composeRouteInputSchema(
    operation({ query, body: parent }),
    'tool',
    normalizeOptions({ inputMode: 'flatten' })
  )
  expect(validateJsonSchema(schema, { name: 'okay', copy: 'okay' }).ok).toBe(true)
  expect(validateJsonSchema(schema, { name: 'okay', copy: 'no' }).ok).toBe(false)
})

test('preserves named resources referenced from a different flattened slot', () => {
  const id = 'https://example.test/shared-target'
  const query = {
    $id: id,
    type: 'object',
    properties: { name: { type: 'string', minLength: 3 } },
    required: ['name']
  }
  const body = {
    type: 'object',
    properties: { copy: { $ref: `${id}#/properties/name` } },
    required: ['copy']
  }
  const schema = composeRouteInputSchema(
    operation({ query, body }),
    'tool',
    normalizeOptions({ inputMode: 'flatten' })
  )
  expect(validateJsonSchema(schema, { name: 'okay', copy: 'okay' }).ok).toBe(true)
  expect(validateJsonSchema(schema, { name: 'okay', copy: 'no' }).ok).toBe(false)
})

test('preserves cross-slot references to relative IDs from anonymous slots', () => {
  for (const id of ['shared.json', '?version=1']) {
    const route = operation({
      query: { $id: id, type: 'object', properties: { original: { type: 'string' } } },
      body: { type: 'object', properties: { copy: { $ref: `${id}#/properties/original` } } }
    })
    const envelope = composeRouteInputSchema(route, 'tool', normalizeOptions())
    const flat = composeRouteInputSchema(route, 'tool', normalizeOptions({ inputMode: 'flatten' }))
    expect(
      validateJsonSchema(envelope, { query: { original: 'abc' }, body: { copy: 'abc' } })
    ).toEqual({ ok: true })
    expect(validateJsonSchema(flat, { original: 'abc', copy: 'abc' })).toEqual({ ok: true })
    expect(validateJsonSchema(flat, { original: 'abc', copy: 3 }).ok).toBe(false)
  }
})

test('keeps application values with schema-like keys intact while embedding resources', () => {
  const data = { $id: 'https://example.test/data', kind: 'value' }
  const body = {
    type: 'object',
    $defs: { name: { type: 'string' } },
    properties: {
      name: { $ref: '#/$defs/name' },
      left: { const: data },
      right: { enum: [data] }
    },
    required: ['name', 'left', 'right']
  }
  const schema = composeRouteInputSchema(
    operation({ body }),
    'tool',
    normalizeOptions({ inputMode: 'flatten' })
  )
  expect(validateJsonSchema(schema, { name: 'okay', left: data, right: data }).ok).toBe(true)
  expect(validateJsonSchema(schema, { name: 'okay', left: data, right: {} }).ok).toBe(false)
})

test('preserves constructor and prototype-named schema properties as own data', () => {
  const properties = JSON.parse(
    '{"constructor":{"type":"string"},"__proto__":{"type":"number"},"toString":{"type":"boolean"}}'
  )
  const schema = { type: 'object', allOf: [{ type: 'object', properties }] }
  const result = objectSchemaProperties(schema)
  expect(Object.getPrototypeOf(result)).toBe(Object.prototype)
  expect(Object.keys(result)).toEqual(['constructor', '__proto__', 'toString'])
  expect(result.constructor as unknown).toEqual({ type: 'string' })
  expect(result.__proto__).toEqual({ type: 'number' })

  const normalized = normalizeJsonSchema(schema, {
    source: 'explicit',
    kind: 'tool',
    schemaLocation: 'input',
    options: normalizeOptions()
  })
  expect(JSON.parse(JSON.stringify(normalized))).toEqual(schema)
  expect(objectSchemaProperties(normalized)).toEqual(result)
  expect(Object.getPrototypeOf(normalized)).toBe(Object.prototype)

  const flattened = composeRouteInputSchema(
    operation({ query: schema }),
    'tool',
    normalizeOptions({ inputMode: 'flatten' })
  )
  const flattenedProperties = flattened.properties as Record<string, unknown>
  expect(Object.getPrototypeOf(flattenedProperties)).toBe(Object.prototype)
  expect(Object.hasOwn(flattenedProperties, '__proto__')).toBe(true)
  expect(flattenedProperties).toEqual(properties)
  expect(
    objectSchemaProperties({
      allOf: [
        { properties: { constructor: { type: 'string' } } },
        { properties: { constructor: { minLength: 2 } } }
      ]
    }).constructor as unknown
  ).toEqual({ allOf: [{ type: 'string' }, { minLength: 2 }] })
  expect(Object.prototype).not.toHaveProperty('polluted')
})

test('counts layer-only params, query, and body schemas for missing-schema diagnostics', () => {
  const options = normalizeOptions({ diagnostics: { failOnMissingSchema: true } })
  for (const slot of ['params', 'query', 'body']) {
    const route = operation({
      schemas: [{ [slot]: { type: 'object', properties: { value: { type: 'string' } } } }]
    })
    expect(getMcpRegistry(route.app, options).tools.size).toBe(1)
  }
  expect(() => getMcpRegistry(operation({}).app, options)).toThrow('Missing input schema')
  expect(() => getMcpRegistry(operation({ schemas: [{ query: undefined }] }).app, options)).toThrow(
    'Missing input schema'
  )
})

test('flattens layered objects with unconstrained schemas in either order', () => {
  const object = {
    type: 'object',
    properties: { name: { type: 'string', minLength: 2 } },
    required: ['name'],
    additionalProperties: false
  }
  for (const sources of [
    [{}, object],
    [object, {}]
  ]) {
    const route = operation({ query: sources[0], schemas: [{ query: sources[1] }] })
    const schema = composeRouteInputSchema(
      route,
      'tool',
      normalizeOptions({ inputMode: 'flatten' })
    )
    expect(schema.properties).toEqual(object.properties)
    expect(schema.required).toEqual(['name'])
    expect(validateJsonSchema(schema, { name: 'okay' }).ok).toBe(true)
    expect(validateJsonSchema(schema, {}).ok).toBe(false)
    expect(validateJsonSchema(schema, { name: 'x' }).ok).toBe(false)
    expect(composeRouteInputSchema(route, 'prompt', normalizeOptions())).toEqual({
      type: 'object',
      allOf: sources
    })
  }
})

test('keeps primitive-only layered schemas in the flattened value envelope', () => {
  const sources = [{ type: 'string' }, { minLength: 2 }]
  const schema = composeRouteInputSchema(
    operation({ query: sources[0], schemas: [{ query: sources[1] }] }),
    'tool',
    normalizeOptions({ inputMode: 'flatten' })
  )
  expect(schema.properties).toEqual({ value: { allOf: sources } })
  expect(schema.required).toEqual(['value'])
  expect(validateJsonSchema(schema, { value: 'okay' }).ok).toBe(true)
  expect(validateJsonSchema(schema, { value: 'x' }).ok).toBe(false)
})

test('preserves scalar semantics of properties-only layers without forcing object type', () => {
  const conditional = {
    properties: { name: { type: 'string' } },
    additionalProperties: false
  }
  for (const sources of [
    [conditional, {}],
    [{}, conditional]
  ]) {
    const route = operation({ query: sources[0], schemas: [{ query: sources[1] }] })
    const options = normalizeOptions({ inputMode: 'flatten' })
    const slot = routeInputSchemaForSlot(route, 'query', options)
    expect(slot).not.toHaveProperty('type')
    expect(isFlattenedObjectSchema(slot)).toBe(false)
    expect(validateJsonSchema(slot!, 'scalar').ok).toBe(true)
    expect(validateJsonSchema(slot!, { name: 'okay' }).ok).toBe(true)
    expect(validateJsonSchema(slot!, { name: 1 }).ok).toBe(false)
    expect(validateJsonSchema(slot!, { name: 'okay', extra: true }).ok).toBe(false)
    expect(composeRouteInputSchema(route, 'tool', options).properties).toEqual({
      value: slot
    })
  }
})

test('keeps nested object constraints in a layered value wrapper', () => {
  const nested = {
    allOf: [
      {
        type: 'object',
        properties: { name: { type: 'string' }, alias: { type: 'string' } },
        maxProperties: 1
      }
    ]
  }
  const route = operation({ body: nested, schemas: [{ body: { type: 'object' } }] })
  const options = normalizeOptions({ inputMode: 'flatten' })
  const schema = composeRouteInputSchema(route, 'tool', options)
  expect(validateJsonSchema(schema, { value: { name: 'okay' } }).ok).toBe(true)
  expect(validateJsonSchema(schema, { value: { name: 'okay', alias: 'other' } }).ok).toBe(false)
  expect(validateJsonSchema(schema, { value: 'not an object' }).ok).toBe(false)
})

test('shares cached mapped slot schemas and their advertised wrapping with invocation', () => {
  const route = operation({ body: { native: true } })
  let mappings = 0
  const mapped = {
    allOf: [
      {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name']
      }
    ]
  }
  const options = normalizeOptions({
    inputMode: 'flatten',
    mapJsonSchema: (schema, context) => {
      expect(schema).toEqual({ native: true })
      expect(context.kind).toBe('tool')
      expect(context.schemaLocation).toBe('body')
      mappings++
      return mapped
    }
  })
  const advertised = composeRouteInputSchema(route, 'tool', options)
  const slot = routeInputSchemaForSlot(route, 'body', options)
  expect(advertised.properties).toEqual({ value: mapped })
  expect(isFlattenedObjectSchema(slot)).toBe(false)
  expect(routeInputSchemaForSlot(route, 'body', options)).toBe(slot)
  expect(mappings).toBe(1)
  expect(validateJsonSchema(advertised, { value: { name: 'okay' } }).ok).toBe(true)
  expect(validateJsonSchema(advertised, { name: 'okay' }).ok).toBe(false)
  const otherOptions = normalizeOptions({ inputMode: 'flatten' })
  expect(routeInputSchemaForSlot(route, 'body', otherOptions)).toEqual({ native: true })
  expect(isFlattenedObjectSchema({ properties: { name: { type: 'string' } } })).toBe(true)
})
