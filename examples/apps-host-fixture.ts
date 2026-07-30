export interface FixtureMessage {
  jsonrpc: '2.0'
  id?: number
  method?: string
  params?: Record<string, unknown>
  result?: unknown
}

/**
 * Bounded protocol fixture for Apps examples. It models only the messages used
 * by these demos and intentionally does not behave like a production Apps host.
 */
export class AppsHostFixture {
  readonly outgoing: FixtureMessage[] = []
  initialized = false
  tornDown = false
  size?: { width: number; height: number }

  receive(message: FixtureMessage): FixtureMessage | undefined {
    if (message.method === 'ui/initialize' && message.id !== undefined) {
      return {
        jsonrpc: '2.0',
        id: message.id,
        result: {
          protocolVersion: '2026-01-26',
          hostInfo: { name: 'bounded-test-host', version: '1.0.0' },
          hostCapabilities: {},
          hostContext: {
            theme: 'light',
            locale: 'en-US',
            displayMode: 'inline',
            availableDisplayModes: ['inline', 'fullscreen']
          }
        }
      }
    }
    if (message.method === 'ui/notifications/initialized') {
      this.initialized = true
      return undefined
    }
    if (message.method === 'tools/call' && message.id !== undefined) {
      return {
        jsonrpc: '2.0',
        id: message.id,
        result: {
          content: [{ type: 'text', text: 'Updated by the fixture.' }],
          structuredContent: { tasks: [] }
        }
      }
    }
    if (message.method === 'ui/notifications/size-changed') {
      const width = message.params?.width
      const height = message.params?.height
      if (typeof width === 'number' && typeof height === 'number') {
        this.size = { width, height }
      }
      return undefined
    }
    if (message.method === 'ui/resource-teardown' && message.id !== undefined) {
      this.tornDown = true
      return { jsonrpc: '2.0', id: message.id, result: {} }
    }
    return undefined
  }

  sendToolInput(arguments_: Record<string, unknown>): void {
    this.outgoing.push({
      jsonrpc: '2.0',
      method: 'ui/notifications/tool-input',
      params: { arguments: arguments_ }
    })
  }

  sendToolResult(result: Record<string, unknown>): void {
    this.outgoing.push({
      jsonrpc: '2.0',
      method: 'ui/notifications/tool-result',
      params: result
    })
  }

  sendHostContextChanged(context: Record<string, unknown>): void {
    this.outgoing.push({
      jsonrpc: '2.0',
      method: 'ui/notifications/host-context-changed',
      params: context
    })
  }
}
