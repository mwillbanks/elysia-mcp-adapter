import { readFileSync } from 'node:fs'
import { createServer } from 'node:https'
import { Elysia } from 'elysia'
import { listenLoopbackTls } from '../../examples/events/listen-fixture.js'
import type {
  McpWebhookSubscriptionProvider,
  McpWebhookSubscriptionRecord
} from '../../src/extensions/events/types.js'
import {
  decodeEventCursor,
  eventPrincipalKey,
  subscribeEventsWebhook,
  unsubscribeEventsWebhook,
  withMcpMethods
} from '../../src/index.js'
import { normalizeOptions } from '../../src/options.js'

const signingKey = 'events-replay-fixture-signing-key-32-bytes'
const records = new Map<string, McpWebhookSubscriptionRecord>()
const authorization = {
  principal: {
    tokenType: 'access_token' as const,
    subject: 'replay-fixture-owner',
    audience: 'mcp',
    expiresAt: Math.floor(Date.now() / 1_000) + 60,
    scopes: []
  },
  scopes: [],
  attributes: {}
}
const provider: McpWebhookSubscriptionProvider = {
  durability: 'durable',
  get: (key) => records.get(key) ?? null,
  upsert: (record) => {
    const created = !records.has(record.key)
    records.set(record.key, structuredClone(record))
    return { record: structuredClone(record), created }
  },
  delete: (key) => records.delete(key),
  list: async function* () {
    yield* records.values()
  },
  authorizeDelivery: () => authorization
}

const bodies: Array<Record<string, unknown>> = []
let resolveFirstReceived = () => {}
const firstReceived = new Promise<void>((resolve) => {
  resolveFirstReceived = resolve
})
let resolveReceived = () => {}
const received = new Promise<void>((resolve) => {
  resolveReceived = resolve
})
const server = createServer({
  key: readFileSync(new URL('./events-network/valid-key.pem', import.meta.url)),
  cert: readFileSync(new URL('./events-network/valid-cert.pem', import.meta.url))
})
server.on('request', (request, response) => {
  void new Response(request as never).json().then((body) => {
    bodies.push(body as Record<string, unknown>)
    if (bodies.length === 1) {
      resolveFirstReceived()
      return
    }
    response.writeHead(bodies.length === 2 ? 500 : 202)
    response.end(bodies.length === 2 ? 'first retry failed' : 'accepted')
    if (bodies.length >= 6) resolveReceived()
  })
})
const port = await listenLoopbackTls(server)

let sentOngoingBatch = false
const app = new Elysia().use(withMcpMethods()).mcpEvent(
  {
    name: 'com.example.truncated-batch',
    description: 'Truncated replay batch',
    delivery: ['webhook'],
    inputSchema: { type: 'object', additionalProperties: false },
    payloadSchema: {
      type: 'object',
      properties: { sequence: { type: 'number' } },
      required: ['sequence'],
      additionalProperties: false
    }
  },
  ({ cursor }) => {
    if (cursor === null) return { events: [], cursor: 'head', nextPollMs: 5 }
    if (cursor === 'head') {
      return {
        events: [
          {
            eventId: 'event-1',
            name: 'com.example.truncated-batch',
            timestamp: '2026-10-01T12:00:00Z',
            data: { sequence: 1 },
            cursor: 'cursor-1'
          },
          {
            eventId: 'event-2',
            name: 'com.example.truncated-batch',
            timestamp: '2026-10-01T12:00:01Z',
            data: { sequence: 2 },
            cursor: 'cursor-2'
          }
        ],
        cursor: 'batch-end',
        truncated: true,
        nextPollMs: 5
      }
    }
    if (cursor === 'batch-end' && !sentOngoingBatch) {
      sentOngoingBatch = true
      return {
        events: [
          {
            eventId: 'event-3',
            name: 'com.example.truncated-batch',
            timestamp: '2026-10-01T12:00:02Z',
            data: { sequence: 3 },
            cursor: 'cursor-3'
          },
          {
            eventId: 'event-4',
            name: 'com.example.truncated-batch',
            timestamp: '2026-10-01T12:00:03Z',
            data: { sequence: 4 },
            cursor: 'cursor-4'
          }
        ],
        cursor: 'second-batch-end',
        truncated: true,
        nextPollMs: 5
      }
    }
    return { events: [], cursor: cursor ?? 'batch-end', nextPollMs: 5 }
  }
)
const options = normalizeOptions({
  transport: { protocolVersions: ['2025-11-25'] },
  extensions: {
    events: {
      cursor: { signingKey },
      pollIntervalMs: 5,
      webhook: {
        provider,
        environment: 'development',
        allowPrivateAddresses: true,
        allowlist: () => true,
        resolveAddresses: async () => [{ address: '127.0.0.1', family: 4 }],
        maxAttempts: 1,
        requestTimeoutMs: 500,
        retryBaseMs: 1
      }
    }
  }
})
const context = {
  request: new Request('http://localhost/mcp'),
  protocolVersion: '2025-11-25' as const,
  authorization
}
const url = `https://callback.test:${port}/hook`
const arguments_ = {}

try {
  const initial = await subscribeEventsWebhook(
    app,
    {
      name: 'com.example.truncated-batch',
      arguments: arguments_,
      cursor: null,
      delivery: {
        mode: 'webhook',
        url,
        secret: `whsec_${Buffer.alloc(24, 21).toString('base64')}`
      }
    },
    options,
    context
  )
  await firstReceived
  const refreshed = await subscribeEventsWebhook(
    app,
    {
      name: 'com.example.truncated-batch',
      arguments: arguments_,
      cursor: initial.cursor,
      maxAgeMs: 1_000,
      delivery: {
        mode: 'webhook',
        url,
        secret: `whsec_${Buffer.alloc(24, 21).toString('base64')}`
      }
    },
    options,
    context
  )
  await Promise.race([
    received,
    Bun.sleep(1_000).then(() => {
      throw new Error(`Timed out waiting for replay deliveries: ${JSON.stringify(bodies)}`)
    })
  ])
  const principal = eventPrincipalKey(authorization)
  if (!principal) throw new Error('Missing replay fixture principal')
  const decoded = bodies.map((body) => {
    if (body.type === 'gap')
      return {
        type: 'gap',
        cursor: decodeEventCursor(
          body.cursor,
          'com.example.truncated-batch',
          arguments_,
          authorization,
          undefined,
          { signingKey, ttlMs: 300_000 }
        ).cursor
      }
    return {
      type: body.eventId,
      cursor: decodeEventCursor(
        body.cursor,
        'com.example.truncated-batch',
        arguments_,
        authorization,
        undefined,
        { signingKey, ttlMs: 300_000 }
      ).cursor
    }
  })
  decoded.push({
    type: 'refresh',
    cursor: decodeEventCursor(
      refreshed.cursor,
      'com.example.truncated-batch',
      arguments_,
      authorization,
      undefined,
      { signingKey, ttlMs: 300_000 }
    ).cursor
  })
  console.log(JSON.stringify(decoded))
  await unsubscribeEventsWebhook(
    app,
    { name: 'com.example.truncated-batch', arguments: arguments_, delivery: { url } },
    options,
    context
  )
} finally {
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
}
