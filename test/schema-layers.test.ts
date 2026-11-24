import { expect, test } from 'bun:test'
import { normalizeOptions } from '../src/options.js'
import { getMcpRegistry } from '../src/registry.js'
import { composeRouteInputSchema } from '../src/schema/compose.js'
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
  const schema = layeredSchema(
    {
      $id: 'https://example.test/direct-layer',
      $defs: { value: { type: 'string', minLength: 3 } },
      type: 'object',
      properties: { value: { $ref: '#/$defs/value' }, direct: { type: 'boolean' } },
      required: ['value', 'direct'],
      additionalProperties: false
    },
    {
      $id: 'https://example.test/inherited-layer',
      $defs: { value: { type: 'string', pattern: '^a' } },
      type: 'object',
      properties: { value: { $ref: '#/$defs/value' }, inherited: { type: 'boolean' } },
      required: ['value', 'inherited'],
      additionalProperties: false
    }
  )
  expect(
    validateJsonSchema(schema, { query: { value: 'abc', direct: true, inherited: true } }).ok
  ).toBe(true)
  for (const value of ['ab', 'xyz']) {
    expect(validateJsonSchema(schema, { query: { value, direct: true, inherited: true } }).ok).toBe(
      false
    )
  }
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
