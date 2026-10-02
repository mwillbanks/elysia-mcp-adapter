import {
  LEGACY_PROTOCOL_VERSION,
  MCP_SERVER_VARIANT_META_KEY
} from '@mwillbanks/elysia-mcp-adapter'
import type { Elysia } from 'elysia'

export async function legacyRpc(
  app: Elysia,
  method: string,
  params: Record<string, unknown>,
  sessionId?: string,
  variant?: string,
  authorization = 'Bearer example-user'
) {
  const response = await app.handle(
    new Request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        authorization,
        'content-type': 'application/json',
        'mcp-protocol-version': LEGACY_PROTOCOL_VERSION,
        ...(sessionId ? { 'mcp-session-id': sessionId } : {})
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method,
        params: variant ? { ...params, _meta: { [MCP_SERVER_VARIANT_META_KEY]: variant } } : params
      })
    })
  )
  return { response, body: (await response.json()) as any }
}

export async function modernRpc(app: Elysia, method: string, params = {}) {
  const named = params as { name?: unknown; uri?: unknown }
  const name =
    method === 'tools/call' ? named.name : method === 'resources/read' ? named.uri : undefined
  const response = await app.handle(
    new Request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        'mcp-protocol-version': '2026-07-28',
        'mcp-method': method,
        ...(typeof name === 'string' ? { 'mcp-name': name } : {})
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method,
        params: {
          ...params,
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientInfo': { name: 'experimental-example', version: '1' },
            'io.modelcontextprotocol/clientCapabilities': {}
          }
        }
      })
    })
  )
  return { response, body: (await response.json()) as any }
}
