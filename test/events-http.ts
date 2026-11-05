import type { Elysia } from 'elysia'

const VERSION = '2026-07-28'
const namedEventMethods = new Set([
  'events/poll',
  'events/stream',
  'events/subscribe',
  'events/unsubscribe'
])

export function eventRequest(
  method: string,
  params: Record<string, unknown> = {},
  options: {
    id?: number
    path?: string
    signal?: AbortSignal
    headers?: Record<string, string>
    clientCapabilities?: Record<string, unknown>
  } = {}
): Request {
  return new Request(`http://localhost${options.path ?? '/mcp'}`, {
    method: 'POST',
    signal: options.signal,
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': VERSION,
      'mcp-method': method,
      ...(namedEventMethods.has(method) && typeof params.name === 'string'
        ? { 'mcp-name': params.name }
        : {}),
      ...options.headers
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: options.id ?? 1,
      method,
      params: {
        ...params,
        _meta: {
          'io.modelcontextprotocol/protocolVersion': VERSION,
          'io.modelcontextprotocol/clientCapabilities': options.clientCapabilities ?? {}
        }
      }
    })
  })
}

export async function eventRpc(
  app: Elysia,
  method: string,
  params?: Record<string, unknown>,
  options?: Parameters<typeof eventRequest>[2]
) {
  const response = await app.handle(eventRequest(method, params, options))
  return {
    status: response.status,
    headers: response.headers,
    body: (await response.json()) as any
  }
}
