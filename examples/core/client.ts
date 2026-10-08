import type { Elysia } from 'elysia'

export async function request(
  app: Elysia,
  method: string,
  params: Record<string, unknown> = {},
  id: string | number = 1
): Promise<Response> {
  const name =
    method === 'tools/call' || method === 'prompts/get'
      ? params.name
      : method === 'resources/read'
        ? params.uri
        : undefined
  return app.handle(
    new Request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2026-07-28',
        'mcp-method': method,
        ...(typeof name === 'string' ? { 'mcp-name': name } : {})
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id,
        method,
        params: {
          ...params,
          _meta: {
            ...(typeof params._meta === 'object' && params._meta ? params._meta : {}),
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientInfo': {
              name: 'modern-core-example-client',
              version: '1.0.0'
            },
            'io.modelcontextprotocol/clientCapabilities': {
              elicitation: { form: {} }
            }
          }
        }
      })
    })
  )
}

export async function jsonRequest(
  app: Elysia,
  method: string,
  params: Record<string, unknown> = {}
): Promise<any> {
  return (await request(app, method, params)).json()
}
