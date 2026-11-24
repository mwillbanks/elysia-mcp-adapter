import { isRecord } from '../internal.js'
import type { JsonSchema } from '../types.js'
import { needsSchemaReferenceScope } from './normalize.js'

const embeddedSchemaBase = 'https://elysia.internal/mcp/flat-input/'

export function embedSchemaResource(schema: JsonSchema, scope: string): JsonSchema {
  if (typeof schema.$id === 'string' || !needsSchemaReferenceScope(schema)) return schema
  // A query-only ID gives fragments a scope without changing the base path.
  return { ...schema, $id: `?elysia-mcp-scope=${encodeURIComponent(scope)}` }
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

type ResourceScope = {
  url: URL
  key: string
  contained: Map<string, ResourceScope>
  parent?: ResourceScope
  replacementQuery?: string
}

function resourceKey(id: URL): string {
  return id.href.split('#', 1)[0]!
}

function createScope(url: URL, parent?: ResourceScope): ResourceScope {
  return { url, key: resourceKey(url), contained: new Map(), parent }
}

export function isolateSchemaResources(schema: JsonSchema): JsonSchema {
  if (!needsSchemaReferenceScope(schema)) return schema
  const root = createScope(new URL(embeddedSchemaBase))
  const resources = new Map<JsonSchema, ResourceScope>()
  collectResources(schema, root, resources)
  const reserved = new Set(Array.from(resources.values(), ({ key }) => key))
  if (reserved.size === resources.size) return schema

  const seen = new Set<string>()
  for (const scope of resources.values()) {
    if (seen.has(scope.key)) {
      scope.replacementQuery = allocateResourceCopy(scope, reserved, seen.size)
    }
    seen.add(scope.key)
  }
  return rewriteSchema(schema, root, resources)
}

function collectResources(
  schema: JsonSchema,
  parent: ResourceScope,
  resources: Map<JsonSchema, ResourceScope>
): void {
  const scope = declaredResourceScope(schema, parent)
  if (scope !== parent) resources.set(schema, scope)
  for (const [key, child] of Object.entries(schema)) {
    mapSchemaChild(key, child, (entry) => {
      if (isRecord(entry)) collectResources(entry, scope, resources)
      return entry
    })
  }
}

function declaredResourceScope(schema: JsonSchema, parent: ResourceScope): ResourceScope {
  const url = typeof schema.$id === 'string' ? URL.parse(schema.$id, parent.url) : null
  if (!url) return parent
  const scope = createScope(url, parent)
  // References outside a copied scope retain the first occurrence of that resource.
  for (let outer: ResourceScope | undefined = parent; outer; outer = outer.parent) {
    if (!outer.contained.has(scope.key)) outer.contained.set(scope.key, scope)
  }
  return scope
}

function rewriteSchema(
  schema: JsonSchema,
  inherited: ResourceScope,
  resources: Map<JsonSchema, ResourceScope>
): JsonSchema {
  const scope = resources.get(schema) ?? inherited
  function rewrite(key: string, value: unknown): unknown {
    if (
      key === '$id' &&
      typeof value === 'string' &&
      scope !== inherited &&
      scope.replacementQuery
    ) {
      return replaceUriQuery(value, scope.replacementQuery)
    }
    if ((key === '$ref' || key === '$dynamicRef') && typeof value === 'string') {
      return rebaseReference(value, scope)
    }
    return mapSchemaChild(key, value, (child) =>
      isRecord(child) ? rewriteSchema(child, scope, resources) : child
    )
  }

  return Object.fromEntries(
    Object.entries(schema).map(([key, value]) => [key, rewrite(key, value)])
  )
}

function rebaseReference(reference: string, scope: ResourceScope): string {
  if (reference.startsWith('#')) return reference
  const target = URL.parse(reference, scope.url)
  if (!target) return reference
  const binding = findResource(scope, resourceKey(target))
  return binding?.replacementQuery
    ? replaceUriQuery(reference, binding.replacementQuery) + target.hash
    : reference
}

function replaceUriQuery(uri: string, query: string): string {
  return `${uri.split(/[?#]/, 1)[0]}${query}`
}

function findResource(scope: ResourceScope | undefined, key: string): ResourceScope | undefined {
  for (let current = scope; current; current = current.parent) {
    if (current.key === key) return current
    const child = current.contained.get(key)
    if (child) return child
  }
  return undefined
}

function allocateResourceCopy(scope: ResourceScope, reserved: Set<string>, index: number): string {
  // A query suffix changes the identity while preserving relative path resolution.
  const id = new URL(scope.url)
  let key: string
  do {
    id.searchParams.set('elysia-mcp-copy', String(index++))
    key = resourceKey(id)
  } while (reserved.has(key))
  reserved.add(key)
  return id.search
}

function mapSchemaChild(key: string, child: unknown, embed: (value: unknown) => unknown): unknown {
  if (schemaArrays.has(key) && Array.isArray(child)) return child.map(embed)
  if (schemaMaps.has(key) && isRecord(child)) {
    return Object.fromEntries(Object.entries(child).map(([name, value]) => [name, embed(value)]))
  }
  return schemaValues.has(key) ? embed(child) : child
}
