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
    switch (message.method) {
      case 'ui/initialize':
        return initializeResponse(message)
      case 'ui/notifications/initialized':
        this.initialized = true
        return undefined
      case 'tools/call':
        return toolCallResponse(message)
      case 'ui/notifications/size-changed':
        this.recordSize(message.params)
        return undefined
      case 'ui/resource-teardown':
        return this.teardownResponse(message)
      default:
        return undefined
    }
  }

  private recordSize(params: Record<string, unknown> | undefined): void {
    const width = params?.width
    const height = params?.height
    if (typeof width === 'number' && typeof height === 'number') this.size = { width, height }
  }

  private teardownResponse(message: FixtureMessage): FixtureMessage | undefined {
    if (message.id === undefined) return undefined
    this.tornDown = true
    return { jsonrpc: '2.0', id: message.id, result: {} }
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

function initializeResponse(message: FixtureMessage): FixtureMessage | undefined {
  if (message.id === undefined) return undefined
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

function toolCallResponse(message: FixtureMessage): FixtureMessage | undefined {
  if (message.id === undefined) return undefined
  return {
    jsonrpc: '2.0',
    id: message.id,
    result: {
      content: [{ type: 'text', text: 'Updated by the fixture.' }],
      structuredContent: { tasks: [] }
    }
  }
}
