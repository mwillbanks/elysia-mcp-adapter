import { describe, expect, test } from 'bun:test'
import { MCP_APPS_RESOURCE_MIME_TYPE } from '@mwillbanks/elysia-mcp-adapter'
import { app } from './server.js'

async function modernRpc(method: string, params: Record<string, unknown> = {}) {
  const name =
    method === 'tools/call' ? params.name : method === 'resources/read' ? params.uri : null
  const response = await app.handle(
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
        id: 1,
        method,
        params: {
          ...params,
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientInfo': { name: 'apps-vanilla-test', version: '1.0.0' },
            'io.modelcontextprotocol/clientCapabilities': {
              extensions: { 'io.modelcontextprotocol/ui': {} }
            }
          }
        }
      })
    })
  )
  return { response, body: (await response.json()) as any }
}

describe('vanilla MCP App server', () => {
  test('publishes tools and a self-contained UI resource', async () => {
    const discovery = await modernRpc('server/discover')
    expect(discovery.body.result.capabilities.extensions['io.modelcontextprotocol/ui']).toEqual({
      mimeTypes: [MCP_APPS_RESOURCE_MIME_TYPE]
    })

    const tools = await modernRpc('tools/list')
    const open = tools.body.result.tools.find(
      (tool: { name: string }) => tool.name === 'weather.open'
    )
    expect(open._meta.ui).toMatchObject({
      resourceUri: 'ui://weather/index.html',
      visibility: ['model', 'app']
    })
    expect(open._meta['ui/resourceUri']).toBe('ui://weather/index.html')
    expect(tools.body.result.tools.map((tool: { name: string }) => tool.name)).not.toContain(
      'weather.refresh'
    )

    const result = await modernRpc('tools/call', { name: 'weather.open', arguments: {} })
    expect(result.body.result).toMatchObject({
      resultType: 'complete',
      content: [{ type: 'text', text: 'Chicago is 72°F and clear.' }],
      structuredContent: { location: 'Chicago', temperature: 72, conditions: 'Clear' }
    })
    const refreshed = await modernRpc('tools/call', { name: 'weather.refresh', arguments: {} })
    expect(refreshed.body.result.structuredContent.temperature).toBe(73)

    const resources = await modernRpc('resources/list')
    expect(resources.body.result.resources[0]).toMatchObject({
      uri: 'ui://weather/index.html',
      mimeType: MCP_APPS_RESOURCE_MIME_TYPE,
      _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] }, prefersBorder: true } }
    })

    const read = await modernRpc('resources/read', { uri: 'ui://weather/index.html' })
    const content = read.body.result.contents[0]
    expect(content.mimeType).toBe(MCP_APPS_RESOURCE_MIME_TYPE)
    expect(content.text.toLowerCase()).toContain('<!doctype html>')
    expect(content.text).not.toMatch(/<script[^>]+src=|<link[^>]+href=/i)
  })
})
