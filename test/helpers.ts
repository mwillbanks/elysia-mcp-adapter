import type { Elysia } from 'elysia'

export async function rpc(
  app: Elysia,
  method: string,
  params?: Record<string, unknown>,
  headers: Record<string, string> = {}
) {
  const response = await app.handle(
    new Request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'mcp-protocol-version': '2025-11-25',
        ...headers
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
    })
  )

  return { status: response.status, body: (await response.json()) as any }
}

export async function modernRpc(
  app: Elysia,
  method: string,
  params: Record<string, unknown> = {},
  headers: Record<string, string> = {}
) {
  const name =
    method === 'tools/call' || method === 'prompts/get'
      ? params.name
      : method === 'resources/read' ||
          method === 'resources/directory/read' ||
          method === 'skills/get'
        ? params.uri
        : method === 'tasks/get' || method === 'tasks/update' || method === 'tasks/cancel'
          ? params.taskId
          : undefined
  const meta = {
    ...(typeof params._meta === 'object' && params._meta !== null ? params._meta : {}),
    'io.modelcontextprotocol/protocolVersion': '2026-07-28',
    'io.modelcontextprotocol/clientInfo': {
      name: 'elysia-mcp-adapter-tests',
      version: '1.0.0'
    },
    'io.modelcontextprotocol/clientCapabilities':
      typeof params._meta === 'object' &&
      params._meta !== null &&
      'io.modelcontextprotocol/clientCapabilities' in params._meta
        ? params._meta['io.modelcontextprotocol/clientCapabilities']
        : {}
  }
  const response = await app.handle(
    new Request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2026-07-28',
        'mcp-method': method,
        ...(typeof name === 'string' ? { 'mcp-name': name } : {}),
        ...headers
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method,
        params: { ...params, _meta: meta }
      })
    })
  )
  return {
    status: response.status,
    headers: response.headers,
    body: (await response.json()) as any
  }
}

export function request(
  app: Elysia,
  method: string,
  headers: Record<string, string> = {},
  body?: string
) {
  return app.handle(
    new Request('http://localhost/mcp', {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body
    })
  )
}
