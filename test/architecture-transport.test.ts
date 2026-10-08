import { describe, expect, test } from 'bun:test'
import { Elysia } from 'elysia'
import {
  LEGACY_PROTOCOL_VERSION,
  type McpServerNotification,
  mcp,
  withMcpMethods
} from '../src/index.js'
import { normalizeOptions } from '../src/options.js'
import {
  subscribeVariantResource,
  unsubscribeVariantResource,
  type VariantSession,
  type VariantSubscriptionRuntime,
  variantSessions
} from '../src/transport/variant-subscriptions.js'

describe('transport architecture boundaries', () => {
  test('rejects fractional subscription request IDs before provider invocation', async () => {
    let providerInvocations = 0
    const app = new Elysia().use(
      mcp({
        allowedRoutes: [],
        core: {
          subscriptions: {
            toolsListChanged: true,
            provider: {
              subscribe: () => {
                providerInvocations += 1
                return emptyNotifications()
              }
            }
          }
        }
      })
    )
    const response = await app.handle(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'mcp-protocol-version': '2026-07-28',
          'mcp-method': 'subscriptions/listen'
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1.5,
          method: 'subscriptions/listen',
          params: {
            notifications: { toolsListChanged: true },
            _meta: {
              'io.modelcontextprotocol/protocolVersion': '2026-07-28',
              'io.modelcontextprotocol/clientInfo': { name: 'test', version: '1' },
              'io.modelcontextprotocol/clientCapabilities': {}
            }
          }
        })
      })
    )
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: { code: -32600 } })
    expect(providerInvocations).toBe(0)
  })

  test('removes terminated variant subscriptions without deleting replacements', async () => {
    const first = controlledNotifications()
    const second = controlledNotifications()
    const sources = [first.iterable, second.iterable]
    const options = normalizeOptions({
      allowedRoutes: [],
      transport: {
        protocolVersion: LEGACY_PROTOCOL_VERSION,
        protocolVersions: [LEGACY_PROTOCOL_VERSION]
      },
      core: {
        subscriptions: {
          resources: true,
          provider: { subscribe: () => sources.shift() as AsyncIterable<McpServerNotification> }
        }
      },
      extensions: {
        variants: {
          variants: [{ id: 'stable', description: 'Stable', resources: ['file:///item'] }]
        }
      }
    })
    const app = new Elysia().use(withMcpMethods()).mcpResource('file:///item', () => 'item')
    const session: VariantSession = {
      variants: [{ id: 'stable', description: 'Stable', resources: ['file:///item'] }],
      streams: new Map(),
      subscriptions: new Map()
    }
    variantSessions(app, options).set('session', session)
    const context = {
      protocol: {
        modern: false as const,
        version: '2025-11-25' as const,
        clientCapabilities: {}
      },
      activeVariant: session.variants[0],
      sessionId: 'session'
    }
    const runtime = variantRuntime()
    const request = new Request('http://localhost/mcp', { method: 'POST' })

    const firstResult = await subscribeVariantResource(
      app,
      { uri: 'file:///item' },
      request,
      options,
      context,
      runtime
    )
    const firstId = firstResult.subscriptionId as string
    let replacementClosed = 0
    const replacement = {
      uri: 'file:///replacement',
      variantId: 'stable',
      close: async () => {
        replacementClosed += 1
      }
    }
    session.subscriptions.set(firstId, replacement)
    first.complete()
    await first.returned
    expect(session.subscriptions.get(firstId)).toBe(replacement)
    await unsubscribeVariantResource(app, { subscriptionId: firstId }, options, context, runtime)
    expect(replacementClosed).toBe(1)

    const secondResult = await subscribeVariantResource(
      app,
      { uri: 'file:///item' },
      request,
      options,
      context,
      runtime
    )
    const secondId = secondResult.subscriptionId as string
    second.complete()
    await second.returned
    expect(session.subscriptions.has(secondId)).toBe(false)
  })
})

function emptyNotifications(): AsyncIterable<McpServerNotification> {
  return {
    [Symbol.asyncIterator]: () => ({
      next: async () => ({ done: true, value: undefined })
    })
  }
}

function controlledNotifications(): {
  iterable: AsyncIterable<McpServerNotification>
  complete: () => void
  returned: Promise<void>
} {
  let complete!: () => void
  let markReturned!: () => void
  const completion = new Promise<void>((resolve) => {
    complete = resolve
  })
  const returned = new Promise<void>((resolve) => {
    markReturned = resolve
  })
  const iterator: AsyncIterableIterator<McpServerNotification> = {
    [Symbol.asyncIterator]() {
      return this
    },
    async next() {
      await completion
      return { done: true, value: undefined }
    },
    async return() {
      markReturned()
      return { done: true, value: undefined }
    }
  }
  return { iterable: iterator, complete, returned }
}

function variantRuntime(): VariantSubscriptionRuntime {
  return {
    invocationContext: async (request, _method, _params, context) => ({
      request,
      signal: context.signal ?? request.signal
    }),
    authorizeRequest: async () => undefined,
    enforceAuthorization: () => undefined,
    isAuthorized: () => true,
    variantAllows: () => true,
    variantPrincipal: () => undefined,
    error: (_code, message) => new Error(message)
  }
}
