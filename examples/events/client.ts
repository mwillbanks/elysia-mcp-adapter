import type { Elysia } from 'elysia'

const PROTOCOL_VERSION = '2026-07-28'

function eventRequest(
  id: number,
  method: string,
  params: Record<string, unknown>,
  options: { authorization?: string; signal?: AbortSignal } = {}
): Request {
  return new Request('http://localhost/mcp', {
    method: 'POST',
    signal: options.signal,
    headers: {
      ...(options.authorization ? { authorization: options.authorization } : {}),
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': PROTOCOL_VERSION,
      'mcp-method': method,
      ...(typeof params.name === 'string' ? { 'mcp-name': params.name } : {})
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id,
      method,
      params: {
        ...params,
        _meta: {
          'io.modelcontextprotocol/protocolVersion': PROTOCOL_VERSION,
          'io.modelcontextprotocol/clientCapabilities': {}
        }
      }
    })
  })
}

export async function rpc(
  app: Elysia,
  method: string,
  params: Record<string, unknown> = {},
  authorization?: string
) {
  const response = await app.handle(eventRequest(1, method, params, { authorization }))
  return { response, body: (await response.json()) as any }
}

export function stream(app: Elysia, params: Record<string, unknown>, signal: AbortSignal) {
  return app.handle(eventRequest(2, 'events/stream', params, { signal }))
}

export type EventStreamMethod =
  | 'notifications/events/active'
  | 'notifications/events/event'
  | 'notifications/events/heartbeat'
  | 'notifications/events/error'
  | 'notifications/events/terminated'

export function parseEventStream(text: string) {
  return text
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice(6)) as { method: EventStreamMethod; params: unknown })
}

export interface WebhookTuple {
  name: string
  arguments: Record<string, unknown>
  url: string
}

export function subscribeWebhook(
  app: Elysia,
  tuple: WebhookTuple,
  secret: string,
  cursor: string | null,
  ttlMs: number | null | undefined,
  authorization?: string,
  options: { maxAgeMs?: number } = {}
) {
  return rpc(
    app,
    'events/subscribe',
    {
      name: tuple.name,
      arguments: tuple.arguments,
      cursor,
      ...(ttlMs === undefined ? {} : { ttlMs }),
      ...(options.maxAgeMs === undefined ? {} : { maxAgeMs: options.maxAgeMs }),
      delivery: { mode: 'webhook', url: tuple.url, secret }
    },
    authorization
  )
}

export function refreshWebhook(
  app: Elysia,
  tuple: WebhookTuple,
  secret: string,
  cursor: string | null,
  ttlMs: number | null | undefined,
  authorization?: string,
  options: { maxAgeMs?: number } = {}
) {
  return subscribeWebhook(app, tuple, secret, cursor, ttlMs, authorization, options)
}

export function unsubscribeWebhook(app: Elysia, tuple: WebhookTuple, authorization?: string) {
  return rpc(
    app,
    'events/unsubscribe',
    {
      name: tuple.name,
      arguments: tuple.arguments,
      delivery: { url: tuple.url }
    },
    authorization
  )
}
