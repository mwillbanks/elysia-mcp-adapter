import { describe, expect, test } from 'bun:test'
import { Elysia } from 'elysia'
import { createMcpSubscriptionPublisher, mcp, type McpInvocationContext } from '../src/index.js'

function subscriptionContext(signal?: AbortSignal): McpInvocationContext {
  return { request: new Request('http://localhost/mcp'), signal } as McpInvocationContext
}

describe('MCP subscription publisher', () => {
  test('filters and coalesces notifications and releases pending reads on abort', async () => {
    const publisher = createMcpSubscriptionPublisher({ maxPending: 1 })
    const abort = new AbortController()
    const iterable = await publisher.provider.subscribe(
      { toolsListChanged: true, resourceSubscriptions: ['file:///items'] },
      subscriptionContext(abort.signal)
    )
    const events = iterable[Symbol.asyncIterator]()
    try {
      publisher.promptsListChanged()
      publisher.resourcesListChanged()
      publisher.resourceUpdated('file:///items-sibling/a')
      publisher.toolsListChanged()
      publisher.toolsListChanged()
      expect(await events.next()).toEqual({
        done: false,
        value: { method: 'notifications/tools/list_changed' }
      })
      const update = events.next()
      publisher.resourceUpdated('file:///items/a')
      expect(await update).toEqual({
        done: false,
        value: { method: 'notifications/resources/updated', params: { uri: 'file:///items/a' } }
      })
      const pending = events.next()
      abort.abort()
      expect(await pending).toEqual({ done: true, value: undefined })
    } finally {
      abort.abort()
      await events.return?.()
    }
  })

  test('isolates slow consumers and releases capacity after overflow', async () => {
    const publisher = createMcpSubscriptionPublisher({ maxPending: 1, maxSubscribers: 2 })
    const filter = { toolsListChanged: true, promptsListChanged: true }
    const slow = (await publisher.provider.subscribe(filter, subscriptionContext()))[
      Symbol.asyncIterator
    ]()
    const fast = (await publisher.provider.subscribe(filter, subscriptionContext()))[
      Symbol.asyncIterator
    ]()
    try {
      expect(() => publisher.provider.subscribe(filter, subscriptionContext())).toThrow('capacity')
      const first = fast.next()
      publisher.toolsListChanged()
      expect((await first).value?.method).toBe('notifications/tools/list_changed')
      const second = fast.next()
      publisher.promptsListChanged()
      expect((await second).value?.method).toBe('notifications/prompts/list_changed')
      await expect(slow.next()).rejects.toThrow('queue exceeded')
      const replacement = await publisher.provider.subscribe(filter, subscriptionContext())
      await replacement[Symbol.asyncIterator]().return?.()
    } finally {
      await slow.return?.()
      await fast.return?.()
    }
  })

  test('delivers only authorized updates after acknowledgement and keeps the stream open', async () => {
    const publisher = createMcpSubscriptionPublisher({ maxPending: 1 })
    const app = new Elysia()
      .use(
        mcp({
          allowedRoutes: [],
          core: { subscriptions: { provider: publisher.provider, resources: true } }
        })
      )
      .mcpResource('file:///items', () => 'collection')
      .mcpResource('file:///items/private/a', () => 'private', {
        authorization: { requiredScopes: ['private'] }
      })
      .mcpResource('file:///items/private/b', () => 'private', {
        authorization: { requiredScopes: ['private'] }
      })
      .mcpResource('file:///items/private/c', () => 'private', {
        authorization: { requiredScopes: ['private'] }
      })
      .mcpResource('file:///items/public', () => 'public')
    const response = await app.handle(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-protocol-version': '2026-07-28',
          'mcp-method': 'subscriptions/listen'
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'publisher',
          method: 'subscriptions/listen',
          params: {
            notifications: { resourceSubscriptions: ['file:///items'] },
            _meta: {
              'io.modelcontextprotocol/protocolVersion': '2026-07-28',
              'io.modelcontextprotocol/clientInfo': { name: 'publisher-tests', version: '1.0.0' },
              'io.modelcontextprotocol/clientCapabilities': {}
            }
          }
        })
      })
    )
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    try {
      const acknowledgement = decoder.decode((await reader.read()).value)
      expect(acknowledgement).toContain('notifications/subscriptions/acknowledged')
      publisher.resourceUpdated('file:///items/private/a')
      publisher.resourceUpdated('file:///items/private/b')
      publisher.resourceUpdated('file:///items/private/c')
      publisher.resourceUpdated('file:///items/public')
      const update = decoder.decode((await reader.read()).value)
      expect(update).toContain('notifications/resources/updated')
      expect(update).toContain('file:///items/public')
      expect(update).not.toContain('file:///items/private')
    } finally {
      await reader.cancel()
    }
  })
})
