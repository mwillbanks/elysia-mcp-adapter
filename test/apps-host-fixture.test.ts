import { describe, expect, test } from 'bun:test'
import { InMemoryTransport } from '@modelcontextprotocol/client'
import { App } from '@modelcontextprotocol/ext-apps'
import { AppBridge } from '@modelcontextprotocol/ext-apps/app-bridge'
import { AppsHostFixture } from '../examples/apps-host-fixture.js'

describe('bounded MCP Apps host fixture', () => {
  test('interoperates through the MCP Apps v2 App and AppBridge APIs', async () => {
    const [appTransport, hostTransport] = InMemoryTransport.createLinkedPair()
    const receivedInputs: unknown[] = []
    const receivedResults: unknown[] = []
    const app = new App(
      { name: 'fixture-app', version: '2.0.0' },
      {},
      { autoResize: false, strict: true }
    )
    app.ontoolinput = (input) => receivedInputs.push(input.arguments)
    app.ontoolresult = (result) => receivedResults.push(result.structuredContent)
    app.onteardown = async () => ({})

    const bridge = new AppBridge(
      null,
      { name: 'fixture-host', version: '2.0.0' },
      { serverTools: {} },
      {
        hostContext: {
          theme: 'light',
          locale: 'en-US',
          displayMode: 'inline',
          availableDisplayModes: ['inline', 'fullscreen']
        }
      }
    )
    bridge.oncalltool = async () => ({
      content: [{ type: 'text', text: 'updated' }],
      structuredContent: { tasks: [] }
    })

    await bridge.connect(hostTransport)
    await app.connect(appTransport, { timeout: 1_000 })
    await bridge.sendToolInput({ arguments: { tasks: [] } })
    await bridge.sendToolResult({
      content: [{ type: 'text', text: 'ready' }],
      structuredContent: { tasks: [] }
    })
    expect(receivedInputs).toEqual([{ tasks: [] }])
    expect(receivedResults).toEqual([{ tasks: [] }])
    expect(await app.callServerTool({ name: 'tasks.toggle', arguments: {} })).toMatchObject({
      structuredContent: { tasks: [] }
    })
    await bridge.teardownResource({}, { timeout: 1_000 })
    await app.close()
    await bridge.close()
  })

  test('covers initialization, tool data, same-server calls, context, resize, and teardown', () => {
    const host = new AppsHostFixture()
    const initialized = host.receive({
      jsonrpc: '2.0',
      id: 1,
      method: 'ui/initialize',
      params: {}
    })
    expect(initialized?.result).toMatchObject({ protocolVersion: '2026-01-26' })

    host.receive({ jsonrpc: '2.0', method: 'ui/notifications/initialized' })
    expect(host.initialized).toBe(true)

    host.sendToolInput({ tasks: [] })
    host.sendToolResult({ structuredContent: { tasks: [] } })
    host.sendHostContextChanged({ theme: 'dark', displayMode: 'fullscreen' })
    expect(host.outgoing.map((message) => message.method)).toEqual([
      'ui/notifications/tool-input',
      'ui/notifications/tool-result',
      'ui/notifications/host-context-changed'
    ])

    const toolResult = host.receive({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'tasks.toggle', arguments: {} }
    })
    expect(toolResult?.result).toMatchObject({ structuredContent: { tasks: [] } })

    host.receive({
      jsonrpc: '2.0',
      method: 'ui/notifications/size-changed',
      params: { width: 480, height: 320 }
    })
    expect(host.size).toEqual({ width: 480, height: 320 })

    host.receive({ jsonrpc: '2.0', id: 3, method: 'ui/resource-teardown' })
    expect(host.tornDown).toBe(true)
  })
})
