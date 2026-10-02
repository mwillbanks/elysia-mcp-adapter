import { setTaskController } from '../extensions/tasks/index.js'
import { isRecord } from '../internal.js'
import type {
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

  if (options.inputMode === 'flatten') {
    const routeParams = extractRouteParamNames(operation.path)
    const params: Record<string, unknown> = {}
    const query: Record<string, unknown> = {}

    for (const [key, item] of Object.entries(value)) {
      if (routeParams.includes(key)) params[key] = item
      else query[key] = item
    }

    const normalizedParams = Object.keys(params).length > 0 ? params : undefined

    if (operation.hooks.body) {
      return {
        params: normalizedParams,
        body: 'value' in value ? value.value : value
      }
    }

    return {
      params: normalizedParams,
      query: Object.keys(query).length > 0 ? query : undefined
    }
  }

  return {
    params: isRecord(value.params) ? value.params : undefined,
    query: isRecord(value.query) ? value.query : undefined,
    body: 'body' in value ? value.body : undefined,
    headers: isRecord(value.headers) ? value.headers : undefined
  }
}

export function buildInternalRequest(
  operation: McpRouteOperation,
  input: RouteInvocationInput,
  context: McpInvocationContext,
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
  if (body instanceof ArrayBuffer) return body
  if (ArrayBuffer.isView(body)) return body as unknown as BodyInit
  if (body instanceof Blob) return body
  if (body instanceof FormData) return body
  if (body instanceof URLSearchParams) return body

  const contentType = headers.get('content-type') ?? ''
  if (contentType.includes('application/x-www-form-urlencoded') && isRecord(body)) {
    const search = new URLSearchParams()
    for (const [key, value] of Object.entries(body)) appendQueryValue(search, key, value)
    return search
  }

  return JSON.stringify(body)
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
