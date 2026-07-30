import { describe, expect, test } from 'bun:test'
import { AppsHostFixture } from '../examples/apps-host-fixture.js'

describe('bounded MCP Apps host fixture', () => {
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
