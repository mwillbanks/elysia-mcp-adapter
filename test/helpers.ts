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
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
    })
  )

  return { status: response.status, body: (await response.json()) as any }
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
