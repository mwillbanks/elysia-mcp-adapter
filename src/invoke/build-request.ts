import { setTaskController } from '../extensions/tasks/index.js'
import { isRecord } from '../internal.js'
import { routeSchemaSources } from '../route-inspector.js'
import { isFlattenedObjectSchema, routeInputSchemaForSlot } from '../schema/compose.js'
import { objectSchemaProperties } from '../schema/normalize.js'
import type {
  JsonSchema,
  McpHandlerContext,
  McpInvocationContext,
  McpRouteOperation,
  NormalizedMcpPluginOptions,
  RouteInvocationInput
} from '../types.js'
import { setMcpInvocationContext } from './context.js'

export function normalizeRouteToolInput(
  args: unknown,
  operation: McpRouteOperation,
  options: NormalizedMcpPluginOptions
): RouteInvocationInput {
  const value = isRecord(args) ? args : {}
  if (options.inputMode === 'flatten') return normalizeFlattenedInput(value, operation, options)
  return normalizeStructuredInput(value)
}

function normalizeStructuredInput(value: Record<string, unknown>): RouteInvocationInput {
  return {
    params: isRecord(value.params) ? value.params : undefined,
    query: isRecord(value.query) ? value.query : undefined,
    body: 'body' in value ? value.body : undefined,
    headers: isRecord(value.headers) ? value.headers : undefined
  }
}

function normalizeFlattenedInput(
  value: Record<string, unknown>,
  operation: McpRouteOperation,
  options: NormalizedMcpPluginOptions
): RouteInvocationInput {
  const routeParams = new Set(extractRouteParamNames(operation.path))
  const entries = Object.entries(value)
  const params = nonEmptyRecord(Object.fromEntries(entries.filter(([key]) => routeParams.has(key))))
  const querySchema = routeInputSchemaForSlot(operation, 'query', options)
  const bodySchema = routeInputSchemaForSlot(operation, 'body', options)

  if (!bodySchema && routeSchemaSources(operation, 'body').length === 0) {
    return normalizeQueryOnlyInput(value, entries, routeParams, params, querySchema)
  }
  if (!querySchema && routeSchemaSources(operation, 'query').length === 0) {
    return normalizeBodyOnlyInput(value, params, bodySchema)
  }
  return normalizeMixedInput(value, entries, routeParams, params, querySchema, bodySchema)
}

function normalizeQueryOnlyInput(
  value: Record<string, unknown>,
  entries: Array<[string, unknown]>,
  routeParams: Set<string>,
  params: Record<string, unknown> | undefined,
  querySchema: JsonSchema | undefined
): RouteInvocationInput {
  const query =
    querySchema && !isFlattenedObjectSchema(querySchema) && isRecord(value.value)
      ? value.value
      : Object.fromEntries(entries.filter(([key]) => !routeParams.has(key)))
  return { params, query: nonEmptyRecord(query) }
}

function normalizeBodyOnlyInput(
  value: Record<string, unknown>,
  params: Record<string, unknown> | undefined,
  bodySchema: JsonSchema | undefined
): RouteInvocationInput {
  const body = isFlattenedObjectSchema(bodySchema)
    ? value
    : Object.hasOwn(value, 'value')
      ? value.value
      : value
  return { params, body }
}

function normalizeMixedInput(
  value: Record<string, unknown>,
  entries: Array<[string, unknown]>,
  routeParams: Set<string>,
  params: Record<string, unknown> | undefined,
  querySchema: JsonSchema | undefined,
  bodySchema: JsonSchema | undefined
): RouteInvocationInput {
  const queryIsWrapped = querySchema !== undefined && !isFlattenedObjectSchema(querySchema)
  const queryNames = queryIsWrapped ? new Set<string>() : schemaPropertyNames(querySchema)
  const query = queryIsWrapped
    ? mixedWrappedQuery(value, routeParams)
    : Object.fromEntries(entries.filter(([key]) => queryNames.has(key)))
  const otherSlots = new Set([...routeParams, ...queryNames])
  if (queryIsWrapped) otherSlots.add('value')
  return {
    params,
    query: nonEmptyRecord(query),
    body: normalizeMixedBody(value, bodySchema, otherSlots)
  }
}

function normalizeMixedBody(
  value: Record<string, unknown>,
  bodySchema: JsonSchema | undefined,
  otherSlots: Set<string>
): unknown {
  if (bodySchema && !isFlattenedObjectSchema(bodySchema)) {
    return Object.hasOwn(value, 'value') ? value.value : undefined
  }
  // A named model may not normalize here. Leave validation of the remaining fields to Elysia.
  if (!bodySchema && !otherSlots.has('value') && Object.hasOwn(value, 'value')) return value.value
  return flattenedBody(value, schemaPropertyNames(bodySchema), otherSlots)
}

function mixedWrappedQuery(
  value: Record<string, unknown>,
  routeParams: Set<string>
): Record<string, unknown> {
  if (isRecord(value.value)) return value.value
  if (!Object.hasOwn(value, 'value') || routeParams.has('value')) return {}
  return { value: value.value }
}

function schemaPropertyNames(schema: JsonSchema | undefined): Set<string> {
  return new Set(Object.keys(objectSchemaProperties(schema)))
}

function flattenedBody(
  value: Record<string, unknown>,
  bodyNames: Set<string>,
  otherSlots: Set<string>
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => !otherSlots.has(key) || bodyNames.has(key))
  )
}

function nonEmptyRecord(value: Record<string, unknown>): Record<string, unknown> | undefined {
  return Object.keys(value).length > 0 ? value : undefined
}

export function buildInternalRequest(
  operation: McpRouteOperation,
  input: RouteInvocationInput,
  context: McpHandlerContext,
  options: NormalizedMcpPluginOptions
): Request {
  const url = buildInternalUrl(operation.path, input.params ?? {}, input.query ?? {})
  const headers = buildInternalHeaders(input, context, options)
  const hasBody = input.body !== undefined && !['GET', 'HEAD'].includes(operation.method)

  if (hasBody && !headers.has('content-type')) {
    headers.set('content-type', 'application/json')
  }

  if (!headers.has('accept')) headers.set('accept', 'application/json')

  const request = new Request(url, {
    method: operation.method,
    headers,
    body: hasBody ? serializeBody(input.body, headers) : undefined,
    signal: context.signal
  })
  setMcpInvocationContext(request, context)
  if (context.task) setTaskController(request, context.task)
  return request
}

function buildInternalUrl(
  path: string,
  params: Record<string, unknown>,
  query: Record<string, unknown>
): string {
  const pathname = applyPathParams(path, params)
  const url = new URL(pathname, 'http://elysia.internal')

  for (const [key, value] of Object.entries(query)) {
    appendQueryValue(url.searchParams, key, value)
  }

  return url.toString()
}

function applyPathParams(path: string, params: Record<string, unknown>): string {
  return path
    .split('/')
    .map((segment) => {
      if (segment.startsWith(':')) {
        const name = segment.slice(1)
        if (!(name in params)) throw new Error(`Missing route param: ${name}`)
        return encodeURIComponent(String(params[name]))
      }

      if (segment === '*') {
        const value = params['*'] ?? params.wildcard
        if (value === undefined) throw new Error('Missing wildcard route param')
        return String(value)
          .split('/')
          .map((part) => encodeURIComponent(part))
          .join('/')
      }

      return segment
    })
    .join('/')
    .replace(/\/+/g, '/')
}

function extractRouteParamNames(path: string): string[] {
  return path
    .split('/')
    .filter((segment) => segment.startsWith(':'))
    .map((segment) => segment.slice(1))
}

function buildInternalHeaders(
  input: RouteInvocationInput,
  context: McpInvocationContext,
  options: NormalizedMcpPluginOptions
): Headers {
  const headers = new Headers()

  for (const name of options.headers.passThroughFromMcpRequest) {
    const value = context.request.headers.get(name)
    if (value !== null) headers.set(name, value)
  }

  if (input.headers) {
    const allowed = new Set(options.headers.allowFromToolInput)
    for (const [name, rawValue] of Object.entries(input.headers)) {
      const normalized = name.toLowerCase()
      if (!allowed.has(normalized)) continue
      if (rawValue === undefined || rawValue === null) continue
      headers.set(normalized, String(rawValue))
    }
  }

  return headers
}

function serializeBody(body: unknown, headers: Headers): BodyInit | undefined {
  if (body === undefined) return undefined
  if (typeof body === 'string') return body
  const native = nativeBody(body)
  if (native !== undefined) return native

  const contentType = headers.get('content-type') ?? ''
  if (contentType.includes('application/x-www-form-urlencoded') && isRecord(body)) {
    const search = new URLSearchParams()
    for (const [key, value] of Object.entries(body)) appendQueryValue(search, key, value)
    return search
  }

  return JSON.stringify(body)
}

function nativeBody(body: unknown): BodyInit | undefined {
  if (body instanceof ArrayBuffer) return body
  if (ArrayBuffer.isView(body)) return body as unknown as BodyInit
  if (body instanceof Blob || body instanceof FormData || body instanceof URLSearchParams)
    return body
  return undefined
}

function appendQueryValue(search: URLSearchParams, key: string, value: unknown): void {
  if (value === undefined || value === null) return

  if (Array.isArray(value)) {
    for (const item of value) appendQueryValue(search, key, item)
    return
  }

  if (typeof value === 'object') {
    search.append(key, JSON.stringify(value))
    return
  }

  search.append(key, String(value))
}
