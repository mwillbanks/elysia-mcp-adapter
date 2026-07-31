import { describe, expect, test } from 'bun:test'
import { MCP_APPS_RESOURCE_MIME_TYPE } from '../../src/index.js'
import { app } from './server.js'

async function modernRpc(method: string, params: Record<string, unknown> = {}) {
  const name =
    method === 'tools/call' ? params.name : method === 'resources/read' ? params.uri : null
  const response = await app.handle(
    new Request('http://localhost/mcp', {
      method: 'POST',
      headers: {
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

describe('React MCP App server', () => {
  test('serves the view and keeps mutation app-only with a fallback', async () => {
    const tools = await modernRpc('tools/list')
    const open = tools.body.result.tools.find(
      (tool: { name: string }) => tool.name === 'tasks.open'
    )
    expect(open._meta.ui).toMatchObject({
      resourceUri: 'ui://tasks/index.html',
      visibility: ['model', 'app']
    })
    expect(tools.body.result.tools.map((tool: { name: string }) => tool.name)).not.toContain(
      'tasks.toggle'
    )

    const initial = await modernRpc('tools/call', { name: 'tasks.open', arguments: {} })
    expect(initial.body.result.content[0].text).toContain('tasks remain')
    expect(initial.body.result.structuredContent.tasks).toHaveLength(2)

    const changed = await modernRpc('tools/call', {
      name: 'tasks.toggle',
      arguments: { id: 'ship', done: true }
    })
    expect(changed.body.result.content[0].text).toBe('0 tasks remain.')

    const resources = await modernRpc('resources/list')
    expect(resources.body.result.resources[0]).toMatchObject({
      uri: 'ui://tasks/index.html',
      mimeType: MCP_APPS_RESOURCE_MIME_TYPE
    })
    const read = await modernRpc('resources/read', { uri: 'ui://tasks/index.html' })
    expect(read.body.result.contents[0].mimeType).toBe(MCP_APPS_RESOURCE_MIME_TYPE)
    expect(read.body.result.contents[0].text.toLowerCase()).toContain('<!doctype html>')
    expect(read.body.result.contents[0].text).toContain('<script')
  })
})
