import { describe, expect, test } from 'bun:test'
import { createHmac } from 'node:crypto'
import Ajv2020Import from 'ajv/dist/2020.js'
import addFormatsImport from 'ajv-formats'
import { Elysia } from 'elysia'
import {
  pollEvents,
  streamEvents,
  subscribeEventsWebhook,
  unsubscribeEventsWebhook
} from '../src/extensions/events/runtime.js'
import type {
  McpEventDefinition,
  McpWebhookSubscriptionProvider,
  McpWebhookSubscriptionRecord
} from '../src/extensions/events/types.js'
import {
  assertEventOccurrence,
  assertEventPollResult,
  incompatibleEventSchema
} from '../src/extensions/events/validation.js'
import {
  canonicalJson,
  createWebhookHeaders,
  decodeEventCursor,
  deliverWebhook,
  deriveWebhookSubscriptionIdentity,
  encodeEventCursor,
  eventPrincipalKey,
  isGloballyRoutableAddress,
  MCP_EVENTS_REVISION,
  McpWebhookNetworkError,
  McpWebhookVerificationError,
  mcp,
  parseWebhookUrl,
  postWebhook,
  recoverWebhookSubscriptions,
  verifyWebhookEndpoint,
  withMcpMethods
} from '../src/index.js'
import { normalizeOptions } from '../src/options.js'
import type { McpPluginOptions } from '../src/types.js'
import eventsSchema from './fixtures/events-proposal.schema.json' with { type: 'json' }
import { rpc } from './helpers.js'

const Ajv2020 = (Ajv2020Import as any).default ?? Ajv2020Import
const addFormats = (addFormatsImport as any).default ?? addFormatsImport

function createEventsSchemaValidator() {
  const ajv = new Ajv2020({ strict: false })
  addFormats(ajv)
  return (definition: string, value: unknown) =>
    ajv.validate({ ...eventsSchema, $ref: `#/$defs/${definition}` }, value)
}

const signingKey = 'events-test-signing-key-contains-more-than-32-bytes'

function eventApp(onPoll?: () => void, webhookPollMs = 60_000) {
  let sequence = 0
  return new Elysia()
    .use(
      mcp({
        allowedRoutes: [],
        transport: {
          protocolVersions: ['2025-11-25'],
          enableGetSse: true,
          enableDeleteSession: true
        },
        extensions: {
          events: {
            version: MCP_EVENTS_REVISION,
            cursor: { signingKey, ttlMs: 60_000 },
            pagination: { signingKey, pageSize: 1 }
          }
        }
      })
    )
    .mcpEvent(
      {
        name: 'com.example.changed',
        description: 'A change occurred',
        delivery: ['poll', 'push', 'webhook'],
        inputSchema: {
          type: 'object',
          properties: { project: { type: 'string' } },
          required: ['project'],
          additionalProperties: false
        },
        payloadSchema: {
          type: 'object',
          properties: { sequence: { type: 'number' } },
          required: ['sequence'],
          additionalProperties: false
        }
      },
      ({ name, cursor, arguments: arguments_ }) => {
        onPoll?.()
        sequence++
        if (arguments_.project === 'webhook')
          return { events: [], cursor: cursor ?? `head-${sequence}`, nextPollMs: webhookPollMs }
        return {
          events: [
            {
              eventId: `event-${sequence}`,
              name,
              timestamp: new Date().toISOString(),
              data: { sequence },
              cursor: `cursor-${sequence}`
            }
          ],
          cursor: cursor ?? `head-${sequence}`,
          nextPollMs: 1
        }
      }
    )
}

describe('experimental events extension', () => {
  test('rearms verification cleanup without expiring cached consent early', async () => {
    const fixture = new URL('./fixtures/events-verification-timer-runner.ts', import.meta.url)
    const child = Bun.spawn([process.execPath, fixture.pathname], {
      cwd: import.meta.dir,
      stdout: 'pipe',
      stderr: 'pipe'
    })
    const deadline = setTimeout(() => child.kill(), 2_000)
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited
    ]).finally(() => clearTimeout(deadline))

    expect(exitCode, stderr).toBe(0)
    expect(JSON.parse(stdout.trim())).toEqual({
      scheduledDelays: [2_147_483_647, 2_500],
      allowlistCalls: 2
    })
  })

  test('validates every defined event wire contract against the pinned proposal fixture', () => {
    const validates = createEventsSchemaValidator()
    const meta = { 'io.modelcontextprotocol/subscriptionId': 42 }
    const occurrence = {
      eventId: 'evt_001',
      name: 'com.example.changed',
      timestamp: '2026-10-01T12:30:00Z',
      data: { sequence: 1 },
      cursor: 'cursor-1'
    }
    const descriptor = {
      name: occurrence.name,
      description: 'A change occurred',
      delivery: ['poll', 'push', 'webhook'],
      inputSchema: { type: 'object' },
      payloadSchema: { type: 'object' }
    }
    const subscription = {
      name: occurrence.name,
      arguments: { project: 'adapter' },
      cursor: null,
      maxAgeMs: 60_000
    }
    const secret = `whsec_${Buffer.alloc(24, 9).toString('base64')}`

    for (const [definition, value] of [
      ['EventDescriptor', descriptor],
      ['EventOccurrence', occurrence],
      ['ListRequest', { cursor: 'page-2' }],
      ['ListResult', { events: [descriptor], nextCursor: 'page-2' }],
      ['PollRequest', { ...subscription, maxEvents: 50 }],
      [
        'PollResult',
        {
          events: [occurrence],
          cursor: 'cursor-1',
          truncated: false,
          hasMore: false,
          nextPollMs: 1_000
        }
      ],
      ['StreamRequest', subscription],
      ['StreamResult', { _meta: {} }],
      [
        'SubscribeRequest',
        {
          ...subscription,
          ttlMs: 60_000,
          delivery: { mode: 'webhook', url: 'https://events.example.test/hook', secret }
        }
      ],
      [
        'SubscribeResult',
        {
          id: 'sub_123',
          refreshBefore: '2026-10-01T13:30:00Z',
          cursor: 'cursor-1',
          truncated: false,
          deliveryStatus: {
            active: true,
            lastDeliveryAt: '2026-10-01T12:30:01Z',
            lastError: null,
            throttled: true,
            retryAfterMs: 1_000
          }
        }
      ],
      [
        'UnsubscribeRequest',
        {
          name: occurrence.name,
          arguments: subscription.arguments,
          delivery: { url: 'https://events.example.test/hook' }
        }
      ],
      ['UnsubscribeResult', {}],
      [
        'StreamNotification',
        {
          jsonrpc: '2.0',
          method: 'notifications/events/active',
          params: { cursor: 'cursor-1', truncated: false, _meta: meta }
        }
      ],
      [
        'StreamNotification',
        {
          jsonrpc: '2.0',
          method: 'notifications/events/event',
          params: { ...occurrence, _meta: meta }
        }
      ],
      [
        'StreamNotification',
        {
          jsonrpc: '2.0',
          method: 'notifications/events/heartbeat',
          params: { cursor: 'cursor-1', _meta: meta }
        }
      ],
      [
        'StreamNotification',
        {
          jsonrpc: '2.0',
          method: 'notifications/events/error',
          params: { error: { code: -32603, message: 'UpstreamError' }, _meta: meta }
        }
      ],
      [
        'StreamNotification',
        {
          jsonrpc: '2.0',
          method: 'notifications/events/terminated',
          params: {
            error: { code: -32012, message: 'Forbidden', data: { reason: 'Access revoked' } },
            _meta: meta
          }
        }
      ],
      ['WebhookBody', occurrence],
      ['WebhookBody', { type: 'verification', challenge: 'nonce' }],
      ['WebhookBody', { type: 'gap', cursor: 'cursor-2' }],
      [
        'WebhookBody',
        {
          type: 'terminated',
          error: { code: -32011, message: 'NotFound', data: { kind: 'event' } }
        }
      ],
      [
        'DefinedProtocolError',
        { code: -32602, message: 'InvalidParams', data: { reason: 'invalid' } }
      ],
      ['DefinedProtocolError', { code: -32011, message: 'NotFound', data: { kind: 'event' } }],
      ['DefinedProtocolError', { code: -32012, message: 'Forbidden' }],
      [
        'DefinedProtocolError',
        { code: -32013, message: 'ResourceExhausted', data: { limit: 'subscriptions', max: 10 } }
      ],
      [
        'DefinedProtocolError',
        { code: -32014, message: 'Unsupported', data: { feature: 'deliveryMode', value: 'push' } }
      ],
      [
        'DefinedProtocolError',
        { code: -32015, message: 'CallbackEndpointError', data: { reason: 'tls_error' } }
      ]
    ] as const)
      expect(validates(definition, value)).toBe(true)

    for (const [definition, value] of [
      ['EventOccurrence', { ...occurrence, timestamp: '10/01/2026' }],
      ['EventOccurrence', { ...occurrence, data: [] }],
      ['PollRequest', { ...subscription, maxEvents: 0 }],
      [
        'SubscribeRequest',
        {
          ...subscription,
          delivery: { mode: 'webhook', url: 'http://127.0.0.1/hook', secret }
        }
      ],
      ['DeliveryStatus', { active: false, lastError: 'raw endpoint response: unauthorized' }],
      [
        'StreamNotification',
        {
          jsonrpc: '2.0',
          method: 'notifications/events/event',
          params: occurrence
        }
      ],
      ['WebhookBody', { type: 'gap', cursor: 4 }],
      [
        'WebhookBody',
        {
          type: 'terminated',
          error: { code: 9_007_199_254_740_992, message: 'unsafe integer' }
        }
      ],
      [
        'DefinedProtocolError',
        { code: -32015, message: 'CallbackEndpointError', data: { reason: 'raw_tls_details' } }
      ]
    ] as const)
      expect(validates(definition, value)).toBe(false)
  })

  test('requires occurrence timestamps with valid ISO 8601 date-time components', () => {
    const definition: McpEventDefinition = {
      name: 'com.example.timestamped',
      description: 'Timestamp validation fixture',
      delivery: ['poll'],
      inputSchema: { type: 'object' },
      payloadSchema: { type: 'object' }
    }
    const occurrence = (timestamp: string) => ({
      eventId: 'event-1',
      name: definition.name,
      timestamp,
      data: {}
    })

    for (const timestamp of [
      '2026-10-01T14:30:00Z',
      '2024-02-29T23:59:59.123456+05:30',
      '2026-10-01T00:00:00-06:00'
    ])
      expect(() => assertEventOccurrence(definition, occurrence(timestamp))).not.toThrow()

    for (const timestamp of [
      '10/01/2026 14:30:00',
      '2026-10-01',
      '2026-10-01T14:30:00',
      '2026-02-29T14:30:00Z',
      '2026-04-31T14:30:00Z',
      '2026-13-01T14:30:00Z',
      '2026-10-01T24:00:00Z',
      '2026-10-01T14:60:00Z',
      '2026-10-01T14:30:60Z',
      '2026-10-01T14:30:00+24:00'
    ])
      expect(() => assertEventOccurrence(definition, occurrence(timestamp))).toThrow(
        'Event occurrence timestamp is invalid'
      )
  })

  test('rejects malformed provider termination errors and sanitizes every delivery mode', async () => {
    const definition: McpEventDefinition = {
      name: 'com.example.invalid-termination',
      description: 'Invalid termination fixture',
      delivery: ['poll', 'push', 'webhook'],
      inputSchema: { type: 'object', additionalProperties: false },
      payloadSchema: { type: 'object' }
    }
    for (const terminated of [
      null,
      { code: 1.5, message: 'invalid' },
      { code: -32603, message: 1 },
      { code: -32603, message: 'invalid', data: [] },
      { code: -32603, message: 'invalid', secret: 'leak' }
    ])
      expect(() =>
        assertEventPollResult(definition, { events: [], cursor: null, terminated } as never, 10)
      ).toThrow('invalid termination error')

    const records = new Map<string, McpWebhookSubscriptionRecord>()
    const authorization = {
      principal: {
        tokenType: 'access_token' as const,
        subject: 'invalid-output-owner',
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
        records.set(record.key, structuredClone(record))
        return { record: structuredClone(record), created: true }
      },
      delete: (key) => records.delete(key),
      list: async function* () {
        yield* records.values()
      },
      authorizeDelivery: () => authorization
    }
    const pluginOptions: McpPluginOptions = {
      allowedRoutes: [],
      transport: { protocolVersions: ['2025-11-25'] },
      extensions: { events: { cursor: { signingKey } } }
    }
    const app = new Elysia().use(mcp(pluginOptions)).mcpEvent(definition, (() => ({
      events: [],
      cursor: null,
      terminated: { code: 1.5, message: 'do not expose provider output', data: [] }
    })) as never)
    const poll = await rpc(app, 'events/poll', {
      name: definition.name,
      arguments: {},
      cursor: null
    })
    expect(poll.body.error).toEqual({ code: -32603, message: 'UpstreamError' })
    expect(createEventsSchemaValidator()('EventError', poll.body.error)).toBe(true)

    const stream = await app.handle(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: {
          accept: 'text/event-stream',
          'content-type': 'application/json',
          'mcp-protocol-version': '2025-11-25'
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 7,
          method: 'events/stream',
          params: { name: definition.name, arguments: {}, cursor: null }
        })
      })
    )
    const streamError = (await stream.json()) as { error: unknown }
    expect(streamError.error).toEqual({ code: -32603, message: 'UpstreamError' })
    expect(createEventsSchemaValidator()('EventError', streamError.error)).toBe(true)

    const directOptions = normalizeOptions({
      ...pluginOptions,
      extensions: {
        events: {
          cursor: { signingKey },
          webhook: {
            provider,
            allowlist: () => true,
            resolveAddresses: async () => [{ address: '8.8.8.8', family: 4 }]
          }
        }
      }
    })
    await expect(
      subscribeEventsWebhook(
        app,
        {
          name: definition.name,
          arguments: {},
          cursor: null,
          delivery: {
            mode: 'webhook',
            url: 'https://events.example.test/invalid',
            secret: `whsec_${Buffer.alloc(24, 2).toString('base64')}`
          }
        },
        directOptions,
        {
          request: new Request('http://localhost/mcp'),
          protocolVersion: '2025-11-25',
          authorization
        }
      )
    ).rejects.toMatchObject({ code: -32603, message: 'UpstreamError' })
    expect(records.size).toBe(0)
  })

  test('classifies additive and breaking event schema evolution conservatively', () => {
    const previous: McpEventDefinition = {
      name: 'com.example.schema',
      description: 'Schema fixture',
      delivery: ['push', 'webhook'],
      inputSchema: {
        type: 'object',
        properties: {
          filter: { type: 'string', enum: ['open', 'closed'] },
          tags: { type: 'array', items: { type: 'string' } },
          labels: { type: 'object', patternProperties: { '^x-': { type: 'string' } } }
        },
        required: ['filter'],
        additionalProperties: false
      },
      payloadSchema: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['created'] },
          nested: {
            type: 'object',
            properties: { value: { type: 'string' } },
            additionalProperties: false
          }
        },
        required: ['kind'],
        additionalProperties: false
      }
    }
    const additive = structuredClone(previous)
    additive.inputSchema = {
      ...additive.inputSchema,
      properties: {
        ...(additive.inputSchema.properties as Record<string, unknown>),
        filter: { type: 'string', enum: ['open', 'closed', 'pending'] },
        optional: { type: 'boolean' }
      },
      required: []
    }
    additive.payloadSchema = {
      ...additive.payloadSchema,
      properties: {
        ...(additive.payloadSchema.properties as Record<string, unknown>),
        kind: { type: 'string', enum: ['created', 'updated'] },
        optional: { type: 'number' }
      }
    }
    expect(incompatibleEventSchema(previous, additive)).toBeNull()

    const breakingInputSchemas = [
      { ...previous.inputSchema, type: 'array' },
      {
        ...previous.inputSchema,
        properties: {
          ...(previous.inputSchema.properties as Record<string, unknown>),
          filter: { type: 'string', enum: ['open'] }
        }
      },
      { ...previous.inputSchema, allOf: [{ type: 'object' }] },
      {
        ...previous.inputSchema,
        properties: {
          ...(previous.inputSchema.properties as Record<string, unknown>),
          tags: { type: 'array', items: { type: 'number' } }
        }
      },
      {
        ...previous.inputSchema,
        properties: {
          ...(previous.inputSchema.properties as Record<string, unknown>),
          labels: { type: 'object', patternProperties: { '^x-': { type: 'number' } } }
        }
      },
      { ...previous.inputSchema, dependentRequired: { filter: ['tags'] } }
    ]
    for (const inputSchema of breakingInputSchemas)
      expect(incompatibleEventSchema(previous, { ...previous, inputSchema })).toBe('inputSchema')

    expect(
      incompatibleEventSchema(previous, {
        ...previous,
        payloadSchema: { ...previous.payloadSchema, required: [] }
      })
    ).toBe('payloadSchema')
  })

  test('signs exact webhook body bytes and emits dual rotation signatures', () => {
    const current = `whsec_${Buffer.alloc(24, 3).toString('base64')}`
    const previous = `whsec_${Buffer.alloc(24, 4).toString('base64')}`
    const body = Buffer.from('{"value":"exact bytes"}\n')
    const record: McpWebhookSubscriptionRecord = {
      key: 'key',
      id: 'sub_id',
      principal: 'principal',
      name: 'event',
      arguments: {},
      url: 'https://example.test/hook',
      secret: current,
      previousSecret: previous,
      previousSecretExpiresAt: Date.now() + 60_000,
      refreshBefore: null,
      verified: true,
      active: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }
    const headers = createWebhookHeaders(record, body, 'event-id', '1234')
    const signed = Buffer.concat([Buffer.from('event-id.1234.'), body])
    const expected = [current, previous]
      .map(
        (secret) =>
          `v1,${createHmac('sha256', Buffer.from(secret.slice(6), 'base64'))
            .update(signed)
            .digest('base64')}`
      )
      .join(' ')
    expect(headers).toMatchObject({
      'webhook-id': 'event-id',
      'webhook-timestamp': '1234',
      'webhook-signature': expected,
      'x-mcp-subscription-id': 'sub_id'
    })
  })
  test('canonicalizes ASCII and distinct Unicode keys independent of insertion order', () => {
    for (const [left, right] of [
      [
        { b: 1, a: 2 },
        { a: 2, b: 1 }
      ],
      [
        { é: 1, é: 2 },
        { é: 2, é: 1 }
      ]
    ] as const)
      expect(canonicalJson(left)).toBe(canonicalJson(right))
  })

  test('binds event cursors to arguments, principals, and variants', async () => {
    const authorization = {
      principal: {
        tokenType: 'access_token' as const,
        subject: 'cursor-owner',
        audience: 'mcp',
        expiresAt: Math.floor(Date.now() / 1000) + 60,
        scopes: []
      },
      scopes: [],
      attributes: {}
    }
    const options = { signingKey, ttlMs: 1 }
    const encoded = encodeEventCursor(
      'upstream',
      'event',
      { a: 1 },
      authorization,
      'stable',
      options
    )
    expect(encoded).toBeString()
    expect(() =>
      decodeEventCursor(encoded, 'event', { a: 2 }, authorization, 'stable', options)
    ).toThrow()
    expect(() =>
      decodeEventCursor(encoded, 'event', { a: 1 }, authorization, 'other', options)
    ).toThrow()
    await Bun.sleep(2)
    expect(decodeEventCursor(encoded, 'event', { a: 1 }, authorization, 'stable', options)).toEqual(
      {
        cursor: 'upstream',
        expired: true
      }
    )
  })
  test('is opt-in, revision-pinned, and legacy-only', () => {
    expect(() =>
      mcp({
        extensions: { events: { cursor: { signingKey } } }
      })
    ).toThrow('legacy-only')
    expect(() =>
      mcp({
        transport: { protocolVersions: ['2025-11-25'] },
        extensions: {
          events: {
            version: 'invalid' as typeof MCP_EVENTS_REVISION,
            cursor: { signingKey }
          }
        }
      })
    ).toThrow('Unsupported events revision')
    expect(() =>
      mcp({
        transport: { protocolVersions: ['2025-11-25'] },
        extensions: {
          events: {
            cursor: { signingKey },
            webhook: {
              provider: { durability: 'ephemeral' } as never,
              allowNoExpiry: true
            }
          }
        }
      })
    ).toThrow('durable provider')
  })

  test('lists descriptors and enforces fresh-start and bound cursor semantics', async () => {
    const app = eventApp()
    const validates = createEventsSchemaValidator()
    const listed = await rpc(app, 'events/list')
    expect(listed.body.result.events).toEqual([
      expect.objectContaining({
        name: 'com.example.changed',
        delivery: ['poll', 'push']
      })
    ])
    expect(validates('ListRequest', {})).toBe(true)
    expect(validates('ListResult', listed.body.result)).toBe(true)
    expect(validates('EventDescriptor', listed.body.result.events[0])).toBe(true)
    const missing = await rpc(app, 'events/poll', {
      name: 'com.example.missing',
      arguments: {}
    })
    expect(missing.body.error).toMatchObject({ code: -32011, message: 'NotFound' })
    expect(validates('DefinedProtocolError', missing.body.error)).toBe(true)
    const malformed = await rpc(app, 'events/poll', {
      name: 'com.example.changed',
      arguments: { project: 1 }
    })
    expect(malformed.body.error).toMatchObject({ code: -32602, message: 'InvalidParams' })

    const fresh = await rpc(app, 'events/poll', {
      name: 'com.example.changed',
      arguments: { project: 'adapter' },
      cursor: null
    })
    expect(fresh.body.result.events).toEqual([])
    expect(fresh.body.result.cursor).toBeString()
    expect(validates('PollResult', fresh.body.result)).toBe(true)

    const replay = await rpc(app, 'events/poll', {
      name: 'com.example.changed',
      arguments: { project: 'adapter' },
      cursor: fresh.body.result.cursor
    })
    expect(replay.body.result.events).toHaveLength(1)
    expect(replay.body.result.events[0]).not.toHaveProperty('cursor')
    expect(
      validates('PollRequest', {
        name: 'com.example.changed',
        arguments: { project: 'adapter' },
        cursor: fresh.body.result.cursor
      })
    ).toBe(true)
    expect(validates('PollResult', replay.body.result)).toBe(true)
    expect(validates('EventOccurrence', replay.body.result.events[0])).toBe(true)

    const tampered = await rpc(app, 'events/poll', {
      name: 'com.example.changed',
      arguments: { project: 'other' },
      cursor: fresh.body.result.cursor
    })
    expect(tampered.body.error).toMatchObject({ code: -32602, message: 'InvalidParams' })
  })

  test('streams only event notifications and binds the parent request id', async () => {
    const app = eventApp()
    const controller = new AbortController()
    const response = await app.handle(
      new Request('http://localhost/mcp', {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream',
          'mcp-protocol-version': '2025-11-25'
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 42,
          method: 'events/stream',
          params: {
            name: 'com.example.changed',
            arguments: { project: 'adapter' },
            cursor: null
          }
        })
      })
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    if (!response.body) throw new Error('Event stream response omitted a body')
    const reader = response.body.getReader()
    const first = new TextDecoder().decode((await reader.read()).value)
    const firstNotification = JSON.parse(
      first
        .split('\n')
        .find((line) => line.startsWith('data: '))
        ?.slice('data: '.length) ?? '{}'
    )
    expect(createEventsSchemaValidator()('StreamNotification', firstNotification)).toBe(true)
    expect(first).toContain('notifications/events/active')
    expect(first).toContain('io.modelcontextprotocol/subscriptionId')
    expect(first).toContain('42')
    expect(first).not.toContain('notifications/tools')
    controller.abort()
    await reader.cancel()
  })

  test('removes resolved polling delay listeners from long-lived streams', async () => {
    const app = eventApp()
    const options = normalizeOptions({
      transport: { protocolVersions: ['2025-11-25'] },
      extensions: {
        events: { cursor: { signingKey }, heartbeatMs: 5, pollIntervalMs: 1 }
      }
    })
    const controller = new AbortController()
    const signal = controller.signal
    const add = signal.addEventListener.bind(signal)
    const remove = signal.removeEventListener.bind(signal)
    let listeners = 0
    Object.defineProperties(signal, {
      addEventListener: {
        value(
          type: string,
          listener: EventListenerOrEventListenerObject,
          options?: boolean | AddEventListenerOptions
        ) {
          if (type === 'abort') listeners++
          return add(type, listener, options)
        }
      },
      removeEventListener: {
        value(
          type: string,
          listener: EventListenerOrEventListenerObject,
          options?: boolean | EventListenerOptions
        ) {
          if (type === 'abort') listeners--
          return remove(type, listener, options)
        }
      }
    })
    const response = await streamEvents(
      app,
      { name: 'com.example.changed', arguments: { project: 'adapter' }, cursor: null },
      7,
      options,
      {
        request: new Request('http://localhost/mcp'),
        protocolVersion: '2025-11-25',
        signal
      }
    )
    if (!response.body) throw new Error('Event stream response omitted a body')
    const reader = response.body.getReader()
    await reader.read()
    await Bun.sleep(20)
    expect(listeners).toBeLessThanOrEqual(2)
    controller.abort()
    await reader.cancel()
    expect(listeners).toBe(0)
  })

  test('delivers the initial replay batch and heartbeats while the provider is pending', async () => {
    let calls = 0
    const app = new Elysia().use(withMcpMethods()).mcpEvent(
      {
        name: 'com.example.replay',
        description: 'Replay event',
        delivery: ['push'],
        inputSchema: { type: 'object', additionalProperties: false },
        payloadSchema: {
          type: 'object',
          properties: { value: { type: 'number' } },
          required: ['value'],
          additionalProperties: false
        }
      },
      async ({ name, cursor }) => {
        calls++
        if (calls === 1)
          return {
            events: [1, 2].map((value) => ({
              eventId: `event-${value}`,
              name,
              timestamp: new Date().toISOString(),
              data: { value },
              cursor: `cursor-${value}`
            })),
            cursor: 'cursor-2',
            nextPollMs: 0
          }
        await Bun.sleep(30)
        return { events: [], cursor, nextPollMs: 30 }
      }
    )
    const options = normalizeOptions({
      transport: { protocolVersions: ['2025-11-25'] },
      extensions: {
        events: { cursor: { signingKey }, heartbeatMs: 5, pollIntervalMs: 1 }
      }
    })
    const eventConfig = options.extensions.events
    if (!eventConfig) throw new Error('Event options were not normalized')
    const supplied = encodeEventCursor(
      'resume',
      'com.example.replay',
      {},
      undefined,
      undefined,
      eventConfig.cursor
    )
    const abort = new AbortController()
    const response = await streamEvents(
      app,
      { name: 'com.example.replay', arguments: {}, cursor: supplied },
      8,
      options,
      {
        request: new Request('http://localhost/mcp'),
        protocolVersion: '2025-11-25',
        signal: abort.signal
      }
    )
    if (!response.body) throw new Error('Replay stream response omitted a body')
    const reader = response.body.getReader()
    let observed = ''
    for (
      let attempt = 0;
      attempt < 8 && !observed.includes('notifications/events/heartbeat');
      attempt++
    ) {
      const next = await reader.read()
      observed += new TextDecoder().decode(next.value)
    }
    expect(observed).toContain('event-1')
    expect(observed).toContain('event-2')
    expect(observed.indexOf('event-1')).toBeLessThan(observed.indexOf('event-2'))
    expect(observed).toContain('notifications/events/heartbeat')
    abort.abort()
    await reader.cancel()
  })

  test('delivers list changes on the general session channel', async () => {
    const app = eventApp()
    const initialized = await app.handle(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'mcp-protocol-version': '2025-11-25' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-11-25',
            capabilities: {},
            clientInfo: { name: 'test', version: '1' }
          }
        })
      })
    )
    const sessionId = initialized.headers.get('mcp-session-id')
    expect(sessionId).toBeString()
    const abort = new AbortController()
    const response = await app.handle(
      new Request('http://localhost/mcp', {
        method: 'GET',
        signal: abort.signal,
        headers: { 'mcp-session-id': sessionId as string, 'mcp-protocol-version': '2025-11-25' }
      })
    )
    if (!response.body) throw new Error('General SSE response omitted a body')
    const reader = response.body.getReader()
    expect(new TextDecoder().decode((await reader.read()).value)).toContain(': connected')
    app.mcpEvent(
      {
        name: 'com.example.added',
        description: 'Added later',
        delivery: ['poll'],
        inputSchema: { type: 'object' },
        payloadSchema: { type: 'object' }
      },
      () => ({ events: [], cursor: null })
    )
    const changed = new TextDecoder().decode((await reader.read()).value)
    expect(changed).toContain('notifications/events/list_changed')
    expect(changed).not.toContain('notifications/events/event')
    abort.abort()
    await reader.cancel()
  })

  test('rejects unsafe webhook URLs and private or reserved address classes', () => {
    for (const value of [
      'http://example.com/hook',
      'https://user:password@example.com/hook',
      'https://example.com/hook#fragment'
    ])
      expect(() => parseWebhookUrl(value)).toThrow()

    expect(isGloballyRoutableAddress('192.0.0.9')).toBe(true)
    expect(isGloballyRoutableAddress('127.0.0.1')).toBe(false)
    expect(isGloballyRoutableAddress('::ffff:0808:0808')).toBe(false)
    expect(isGloballyRoutableAddress('4000::1')).toBe(false)
    expect(isGloballyRoutableAddress('2606:4700:4700::1111')).toBe(true)
  })

  test('bounds DNS resolution for pre-aborted and stalled webhook requests', async () => {
    const endpoint = new URL('https://example.test/hook')
    const preAborted = new AbortController()
    preAborted.abort()
    await expect(
      postWebhook(
        endpoint,
        new Uint8Array(),
        {},
        {
          requestTimeoutMs: 10,
          maxResponseBytes: 16,
          allowPrivateAddresses: false,
          resolveAddresses: () => new Promise(() => {})
        },
        preAborted.signal
      )
    ).rejects.toBeInstanceOf(McpWebhookNetworkError)

    const started = Date.now()
    await expect(
      postWebhook(
        endpoint,
        new Uint8Array(),
        {},
        {
          requestTimeoutMs: 10,
          maxResponseBytes: 16,
          allowPrivateAddresses: false,
          resolveAddresses: () => new Promise(() => {})
        }
      )
    ).rejects.toBeInstanceOf(McpWebhookNetworkError)
    expect(Date.now() - started).toBeLessThan(250)

    const normalizedVerification = normalizeOptions({
      transport: { protocolVersions: ['2025-11-25'] },
      extensions: {
        events: {
          cursor: { signingKey },
          webhook: {
            provider: {} as never,
            allowlist: () => true,
            requestTimeoutMs: 10,
            resolveAddresses: () => new Promise(() => {})
          }
        }
      }
    })
    const verificationOptions = normalizedVerification.extensions.events?.webhook
    if (!verificationOptions) throw new Error('Webhook options were not normalized')
    await expect(
      verifyWebhookEndpoint(
        {
          key: 'key',
          id: 'sub_id',
          principal: 'principal',
          name: 'event',
          arguments: {},
          url: 'https://example.test/hook',
          secret: `whsec_${Buffer.alloc(24).toString('base64')}`,
          refreshBefore: new Date(Date.now() + 60_000).toISOString(),
          verified: false,
          active: true,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        },
        { request: new Request('http://localhost/mcp'), protocolVersion: '2025-11-25' },
        verificationOptions
      )
    ).rejects.toBeInstanceOf(McpWebhookNetworkError)

    const retryStarted = Date.now()
    const delivery = await deliverWebhook(
      {
        key: 'key',
        id: 'sub_id',
        principal: 'principal',
        name: 'event',
        arguments: {},
        url: 'https://example.test/hook',
        secret: `whsec_${Buffer.alloc(24).toString('base64')}`,
        refreshBefore: new Date(Date.now() + 60_000).toISOString(),
        verified: true,
        active: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      },
      { eventId: 'event', name: 'event', timestamp: new Date().toISOString(), data: {} },
      'event',
      {
        ...verificationOptions,
        maxAttempts: 5,
        maxRetryElapsedMs: 25,
        retryBaseMs: 1,
        requestTimeoutMs: 1_000
      }
    )
    expect(delivery.acknowledged).toBe(false)
    expect(Date.now() - retryStarted).toBeLessThan(250)
  })

  test('isolates webhook verification consent and challenge throttles by app and options', async () => {
    const provider = { durability: 'durable' } as never
    const allowlistCalls = new Map<string, number>()
    const configured = normalizeOptions({
      transport: { protocolVersions: ['2025-11-25'] },
      extensions: {
        events: {
          cursor: { signingKey },
          webhook: {
            provider,
            allowlist: (_url, context) => {
              const label = context.request.headers.get('x-policy') ?? 'unknown'
              allowlistCalls.set(label, (allowlistCalls.get(label) ?? 0) + 1)
              return true
            },
            resolveAddresses: async () => [{ address: '8.8.8.8', family: 4 }]
          }
        }
      }
    })
    const alternate = normalizeOptions({
      transport: { protocolVersions: ['2025-11-25'] },
      extensions: {
        events: {
          cursor: { signingKey },
          webhook: {
            provider,
            allowlist: () => {
              allowlistCalls.set('alternate', (allowlistCalls.get('alternate') ?? 0) + 1)
              return true
            },
            resolveAddresses: async () => [{ address: '8.8.8.8', family: 4 }]
          }
        }
      }
    })
    const webhook = configured.extensions.events?.webhook
    const alternateWebhook = alternate.extensions.events?.webhook
    if (!webhook || !alternateWebhook) throw new Error('Webhook options were not normalized')
    const record = {
      key: 'verification-isolation',
      id: 'sub_verification_isolation',
      principal: 'verification-owner',
      name: 'com.example.changed',
      arguments: {},
      url: 'https://verification.example.test/hook',
      secret: `whsec_${Buffer.alloc(24).toString('base64')}`,
      refreshBefore: new Date(Date.now() + 60_000).toISOString(),
      verified: false,
      active: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }
    const appA = new Elysia()
    const appB = new Elysia()
    const context = (label: string, signal?: AbortSignal) => ({
      request: new Request('http://localhost/mcp', { headers: { 'x-policy': label }, signal }),
      protocolVersion: '2025-11-25' as const,
      signal
    })

    await verifyWebhookEndpoint(record, context('app-a'), webhook, {
      app: appA,
      options: configured
    })
    await verifyWebhookEndpoint(record, context('app-a'), webhook, {
      app: appA,
      options: configured
    })
    await verifyWebhookEndpoint(record, context('app-b'), webhook, {
      app: appB,
      options: configured
    })
    await verifyWebhookEndpoint(record, context('alternate'), alternateWebhook, {
      app: appA,
      options: alternate
    })
    expect(Object.fromEntries(allowlistCalls)).toEqual({ 'app-a': 1, 'app-b': 1, alternate: 1 })

    const challengeConfigured = normalizeOptions({
      transport: { protocolVersions: ['2025-11-25'] },
      extensions: {
        events: {
          cursor: { signingKey },
          webhook: {
            provider,
            resolveAddresses: async () => [{ address: '8.8.8.8', family: 4 }]
          }
        }
      }
    })
    const challengeWebhook = challengeConfigured.extensions.events?.webhook
    if (!challengeWebhook) throw new Error('Challenge options were not normalized')
    const aborted = new AbortController()
    aborted.abort('test cancellation')
    await expect(
      verifyWebhookEndpoint(record, context('challenge-a', aborted.signal), challengeWebhook, {
        app: appA,
        options: challengeConfigured
      })
    ).rejects.toBeInstanceOf(McpWebhookNetworkError)
    await expect(
      verifyWebhookEndpoint(record, context('challenge-a', aborted.signal), challengeWebhook, {
        app: appA,
        options: challengeConfigured
      })
    ).rejects.toBeInstanceOf(McpWebhookVerificationError)
    await expect(
      verifyWebhookEndpoint(record, context('challenge-b', aborted.signal), challengeWebhook, {
        app: appB,
        options: challengeConfigured
      })
    ).rejects.toBeInstanceOf(McpWebhookNetworkError)
  })

  test('isolates event sessions between two endpoints on one application', async () => {
    const eventOptions = {
      cursor: { signingKey },
      heartbeatMs: 10,
      pollIntervalMs: 10
    }
    const app = new Elysia()
      .use(
        mcp({
          path: '/events-a',
          allowedRoutes: [],
          transport: {
            protocolVersions: ['2025-11-25'],
            enableGetSse: true,
            enableDeleteSession: true
          },
          extensions: { events: eventOptions }
        })
      )
      .use(
        mcp({
          path: '/events-b',
          allowedRoutes: [],
          transport: {
            protocolVersions: ['2025-11-25'],
            enableGetSse: true,
            enableDeleteSession: true
          },
          extensions: { events: eventOptions }
        })
      )
    const initialize = async (path: string) => {
      const response = await app.handle(
        new Request(`http://localhost${path}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'mcp-protocol-version': '2025-11-25'
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {
              protocolVersion: '2025-11-25',
              clientInfo: { name: 'test', version: '1' },
              capabilities: {}
            }
          })
        })
      )
      return response.headers.get('mcp-session-id') as string
    }
    const sessionA = await initialize('/events-a')
    const sessionB = await initialize('/events-b')
    const crossDelete = await app.handle(
      new Request('http://localhost/events-b', {
        method: 'DELETE',
        headers: { 'mcp-session-id': sessionA }
      })
    )
    expect(crossDelete.status).toBe(400)
    const crossStream = await app.handle(
      new Request('http://localhost/events-b', {
        headers: { 'mcp-session-id': sessionA }
      })
    )
    await expect(new Response(crossStream.body).text()).rejects.toThrow()

    const ownStream = await app.handle(
      new Request('http://localhost/events-b', {
        headers: { 'mcp-session-id': sessionB }
      })
    )
    const reader = ownStream.body?.getReader()
    expect(new TextDecoder().decode((await reader?.read())?.value)).toContain(': connected')
    await reader?.cancel()
    const intactA = await app.handle(
      new Request('http://localhost/events-a', {
        method: 'DELETE',
        headers: { 'mcp-session-id': sessionA }
      })
    )
    expect(intactA.status).toBe(202)
  })

  test('isolates webhook workers and poll leases between configurations on one app', async () => {
    const subscriptions: string[] = []
    const unsubscriptions: string[] = []
    const app = new Elysia().use(withMcpMethods()).mcpEvent(
      {
        name: 'com.example.isolated',
        description: 'Isolated event',
        delivery: ['poll', 'webhook'],
        inputSchema: { type: 'object', additionalProperties: false },
        payloadSchema: { type: 'object' },
        onSubscribe: (_arguments, _id, context) => {
          subscriptions.push(context.request.headers.get('x-config') ?? 'unknown')
        },
        onUnsubscribe: (_arguments, _id, context) => {
          unsubscriptions.push(context.request.headers.get('x-config') ?? 'unknown')
        }
      },
      () => ({ events: [], cursor: 'head', nextPollMs: 5 })
    )
    const authorization = {
      principal: {
        tokenType: 'access_token' as const,
        subject: 'configuration-owner',
        audience: 'mcp',
        expiresAt: Math.floor(Date.now() / 1_000) + 60,
        scopes: []
      },
      scopes: [],
      attributes: {}
    }
    const context = (label: string) => ({
      request: new Request('http://localhost/mcp', { headers: { 'x-config': label } }),
      protocolVersion: '2025-11-25' as const,
      authorization
    })
    const createProvider = () => {
      const records = new Map<string, McpWebhookSubscriptionRecord>()
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
      return { provider, records }
    }
    const sourceA = createProvider()
    const sourceB = createProvider()
    const configured = (provider?: McpWebhookSubscriptionProvider) =>
      normalizeOptions({
        transport: { protocolVersions: ['2025-11-25'] },
        extensions: {
          events: {
            cursor: { signingKey },
            pollIntervalMs: 5,
            pollLeaseMs: 10,
            ...(provider
              ? {
                  webhook: {
                    provider,
                    allowlist: () => true,
                    resolveAddresses: async () => [{ address: '8.8.8.8', family: 4 as const }]
                  }
                }
              : {})
          }
        }
      })
    const pollA = configured()
    const pollB = configured()
    const pollParams = { name: 'com.example.isolated', arguments: {}, cursor: null }
    await pollEvents(app, pollParams, pollA, context('poll-a'))
    await pollEvents(app, pollParams, pollB, context('poll-b'))
    expect(subscriptions).toEqual(['poll-a', 'poll-b'])
    for (
      let attempt = 0;
      attempt < 100 && !(unsubscriptions.includes('poll-a') && unsubscriptions.includes('poll-b'));
      attempt++
    )
      await Bun.sleep(5)
    expect(
      [...unsubscriptions].sort(),
      `Expected both poll leases to expire, observed: ${unsubscriptions.join(', ') || 'none'}`
    ).toEqual(['poll-a', 'poll-b'])

    subscriptions.length = 0
    unsubscriptions.length = 0
    const webhookA = configured(sourceA.provider)
    const webhookB = configured(sourceB.provider)
    const url = 'https://events.example.test/isolated'
    const params = {
      name: 'com.example.isolated',
      arguments: {},
      cursor: null,
      delivery: {
        mode: 'webhook',
        url,
        secret: `whsec_${Buffer.alloc(24, 3).toString('base64')}`
      }
    }
    const subscribedA = await subscribeEventsWebhook(app, params, webhookA, context('webhook-a'))
    const subscribedB = await subscribeEventsWebhook(app, params, webhookB, context('webhook-b'))
    expect(subscribedA.id).toBe(subscribedB.id)
    expect(subscriptions).toEqual(['webhook-a', 'webhook-b'])
    await unsubscribeEventsWebhook(
      app,
      { name: params.name, arguments: params.arguments, delivery: { url } },
      webhookB,
      context('webhook-b')
    )
    expect(sourceB.records.size).toBe(0)
    expect(sourceA.records.size).toBe(1)
    expect(unsubscriptions).toEqual(['webhook-b'])

    await subscribeEventsWebhook(app, params, webhookA, context('webhook-a'))
    expect(subscriptions).toEqual(['webhook-a', 'webhook-b'])
    await unsubscribeEventsWebhook(
      app,
      { name: params.name, arguments: params.arguments, delivery: { url } },
      webhookA,
      context('webhook-a')
    )
    expect(unsubscriptions).toEqual(['webhook-b', 'webhook-a'])
  })

  test('persists webhook ownership and removes subscriptions by the original tuple', async () => {
    const validates = createEventsSchemaValidator()
    let polls = 0
    let resolutionFails = false
    const records = new Map<string, McpWebhookSubscriptionRecord>()
    const provider: McpWebhookSubscriptionProvider = {
      durability: 'durable',
      get: (key) => records.get(key) ?? null,
      upsert: (record, { maxSubscriptionsPerPrincipal }) => {
        const count = [...records.values()].filter(
          ({ principal }) => principal === record.principal
        ).length
        if (!records.has(record.key) && count >= maxSubscriptionsPerPrincipal)
          return { limitExceeded: true }
        records.set(record.key, structuredClone(record))
        return { record: structuredClone(record), created: count === 0 }
      },
      delete: (key) => records.delete(key),
      list: async function* () {
        yield* records.values()
      },
      authorizeDelivery: () => authorization
    }
    const options = normalizeOptions({
      allowedRoutes: [],
      transport: { protocolVersions: ['2025-11-25'] },
      extensions: {
        events: {
          cursor: { signingKey },
          pollIntervalMs: 5,
          webhook: {
            provider,
            allowNoExpiry: true,
            minTtlMs: 1_000,
            defaultTtlMs: 5_000,
            maxTtlMs: 10_000,
            allowlist: () => true,
            resolveAddresses: async () => {
              if (resolutionFails) throw new Error('resolver unavailable')
              return [{ address: '8.8.8.8', family: 4 }]
            }
          }
        }
      }
    })
    const app = eventApp(() => polls++, 5)
    const authorization = {
      principal: {
        tokenType: 'access_token' as const,
        subject: 'owner',
        audience: 'mcp',
        expiresAt: Math.floor(Date.now() / 1000) + 60,
        scopes: []
      },
      scopes: [],
      attributes: {}
    }
    const context = {
      request: new Request('http://localhost/mcp'),
      protocolVersion: '2025-11-25' as const,
      authorization
    }
    const params = {
      name: 'com.example.changed',
      arguments: { project: 'webhook' },
      cursor: null,
      ttlMs: null,
      delivery: {
        mode: 'webhook',
        url: 'https://events.example.test/hook',
        secret: `whsec_${Buffer.alloc(24, 7).toString('base64')}`
      }
    }
    expect(validates('SubscribeRequest', params)).toBe(true)
    const ttlContext = {
      ...context,
      meta: { 'io.modelcontextprotocol/server-variant': 'ttl-bounds' }
    }
    const floorStarted = Date.now()
    const floorGrant = await subscribeEventsWebhook(
      app,
      { ...params, ttlMs: 1 },
      options,
      ttlContext
    )
    const floorTtl = Date.parse(String(floorGrant.refreshBefore)) - floorStarted
    expect(floorTtl).toBeGreaterThanOrEqual(900)
    expect(floorTtl).toBeLessThanOrEqual(1_100)
    const ceilingStarted = Date.now()
    const ceilingGrant = await subscribeEventsWebhook(
      app,
      { ...params, ttlMs: 100_000 },
      options,
      ttlContext
    )
    const ceilingTtl = Date.parse(String(ceilingGrant.refreshBefore)) - ceilingStarted
    expect(ceilingTtl).toBeGreaterThanOrEqual(9_900)
    expect(ceilingTtl).toBeLessThanOrEqual(10_100)
    await unsubscribeEventsWebhook(
      app,
      { name: params.name, arguments: params.arguments, delivery: { url: params.delivery.url } },
      options,
      ttlContext
    )
    expect(records.size).toBe(0)
    const subscribed = await subscribeEventsWebhook(app, params, options, context)
    expect(subscribed).toMatchObject({ refreshBefore: null })
    expect(validates('SubscribeResult', subscribed)).toBe(true)
    expect(records.size).toBe(1)
    for (let attempt = 0; attempt < 20 && polls === 0; attempt++) await Bun.sleep(5)
    const beforeFailedRefresh = structuredClone(records.values().next().value)
    const pollsBeforeFailedRefresh = polls
    resolutionFails = true
    await expect(
      subscribeEventsWebhook(
        app,
        {
          ...params,
          ttlMs: 60_000,
          delivery: {
            ...params.delivery,
            secret: `whsec_${Buffer.alloc(24, 8).toString('base64')}`
          }
        },
        options,
        context
      )
    ).rejects.toMatchObject({ code: -32015, message: 'CallbackEndpointError' })
    expect(records.values().next().value).toEqual(beforeFailedRefresh)
    for (let attempt = 0; attempt < 20 && polls === pollsBeforeFailedRefresh; attempt++)
      await Bun.sleep(5)
    expect(polls).toBeGreaterThan(pollsBeforeFailedRefresh)
    resolutionFails = false
    const stableContext = {
      ...context,
      meta: { 'io.modelcontextprotocol/server-variant': 'stable' }
    }
    const experimentalContext = {
      ...context,
      meta: { 'io.modelcontextprotocol/server-variant': 'experimental' }
    }
    const stable = await subscribeEventsWebhook(app, params, options, stableContext)
    const experimental = await subscribeEventsWebhook(app, params, options, experimentalContext)
    expect(stable.id).not.toBe(experimental.id)
    expect(stable.id).not.toBe(subscribed.id)
    expect(records.size).toBe(3)
    await unsubscribeEventsWebhook(
      app,
      { name: params.name, arguments: params.arguments, delivery: { url: params.delivery.url } },
      options,
      stableContext
    )
    expect(records.size).toBe(2)
    await expect(
      unsubscribeEventsWebhook(
        app,
        { name: params.name, arguments: params.arguments, delivery: { url: params.delivery.url } },
        options,
        stableContext
      )
    ).rejects.toMatchObject({ code: -32011, message: 'NotFound' })
    await unsubscribeEventsWebhook(
      app,
      { name: params.name, arguments: params.arguments, delivery: { url: params.delivery.url } },
      options,
      experimentalContext
    )
    expect(records.size).toBe(1)
    await expect(
      unsubscribeEventsWebhook(
        app,
        { name: params.name, arguments: params.arguments, delivery: { url: params.delivery.url } },
        options,
        {
          ...context,
          authorization: {
            ...authorization,
            principal: { ...authorization.principal, subject: 'other-owner' }
          }
        }
      )
    ).rejects.toMatchObject({ code: -32011, message: 'NotFound' })
    const unsubscribeRequest = {
      name: params.name,
      arguments: params.arguments,
      delivery: { url: params.delivery.url }
    }
    expect(validates('UnsubscribeRequest', unsubscribeRequest)).toBe(true)
    const unsubscribed = await unsubscribeEventsWebhook(app, unsubscribeRequest, options, context)
    expect(unsubscribed).toEqual({})
    expect(validates('UnsubscribeResult', unsubscribed)).toBe(true)
    expect(records.size).toBe(0)
  })

  test('primes webhook cursors and preserves request replay bounds across refresh and recovery', async () => {
    const records = new Map<string, McpWebhookSubscriptionRecord>()
    const observed: Array<{ cursor: string | null; maxAgeMs?: number; scenario: unknown }> = []
    let applyRefreshFloor = false
    let failRefreshPrime = false
    const authorization = {
      principal: {
        tokenType: 'access_token' as const,
        subject: 'prime-owner',
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
    const options = normalizeOptions({
      transport: { protocolVersions: ['2025-11-25'] },
      extensions: {
        events: {
          cursor: { signingKey, ttlMs: 1 },
          maxAgeMs: 10_000,
          pollIntervalMs: 5,
          webhook: {
            provider,
            environment: 'development',
            allowPrivateAddresses: true,
            allowlist: () => true,
            resolveAddresses: async () => [{ address: '127.0.0.1', family: 4 }],
            maxAttempts: 1,
            requestTimeoutMs: 10
          }
        }
      }
    })
    const app = new Elysia().use(withMcpMethods()).mcpEvent(
      {
        name: 'com.example.prime',
        description: 'Cursor priming event',
        delivery: ['webhook'],
        inputSchema: {
          type: 'object',
          properties: { scenario: { type: 'string' } },
          required: ['scenario'],
          additionalProperties: false
        },
        payloadSchema: { type: 'object' }
      },
      ({ cursor, maxAgeMs, arguments: arguments_ }) => {
        observed.push({ cursor, maxAgeMs, scenario: arguments_.scenario })
        if (failRefreshPrime && maxAgeMs === 333) throw new Error('refresh prime failed')
        if (
          applyRefreshFloor &&
          arguments_.scenario === 'fresh' &&
          cursor === 'head-fresh' &&
          maxAgeMs === 500
        ) {
          applyRefreshFloor = false
          return { events: [], cursor: 'floor-fresh', truncated: true, nextPollMs: 5 }
        }
        if (cursor !== null) return { events: [], cursor, nextPollMs: 5 }
        return {
          events: [
            {
              eventId: `historical-${String(arguments_.scenario)}`,
              name: 'com.example.prime',
              timestamp: '2026-10-01T12:00:00Z',
              data: {},
              cursor: `historical-cursor-${String(arguments_.scenario)}`
            }
          ],
          cursor: `head-${String(arguments_.scenario)}`,
          hasMore: true,
          nextPollMs: 5
        }
      }
    )
    const context = {
      request: new Request('http://localhost/mcp'),
      protocolVersion: '2025-11-25' as const,
      authorization
    }
    const secret = `whsec_${Buffer.alloc(24, 15).toString('base64')}`
    const freshParams = {
      name: 'com.example.prime',
      arguments: { scenario: 'fresh' },
      cursor: null,
      maxAgeMs: 1_000,
      delivery: {
        mode: 'webhook',
        url: 'https://127.0.0.1:1/fresh',
        secret
      }
    }
    const fresh = await subscribeEventsWebhook(app, freshParams, options, context)
    expect(fresh.truncated).toBe(false)
    expect(
      decodeEventCursor(
        fresh.cursor,
        freshParams.name,
        freshParams.arguments,
        authorization,
        undefined,
        { signingKey, ttlMs: 1 }
      ).cursor
    ).toBe('head-fresh')
    expect(observed[0]).toEqual({ cursor: null, maxAgeMs: 1_000, scenario: 'fresh' })
    expect(records.values().next().value?.maxAgeMs).toBe(1_000)

    applyRefreshFloor = true
    const refreshed = await subscribeEventsWebhook(
      app,
      { ...freshParams, maxAgeMs: 500 },
      options,
      context
    )
    expect(refreshed.truncated).toBe(true)
    expect(
      decodeEventCursor(
        refreshed.cursor,
        freshParams.name,
        freshParams.arguments,
        authorization,
        undefined,
        { signingKey, ttlMs: 1 }
      ).cursor
    ).toBe('floor-fresh')
    expect(
      [...records.values()].find(({ arguments: value }) => value.scenario === 'fresh')?.maxAgeMs
    ).toBe(500)
    for (
      let attempt = 0;
      attempt < 20 &&
      !observed.some(({ scenario, maxAgeMs }) => scenario === 'fresh' && maxAgeMs === 500);
      attempt++
    )
      await Bun.sleep(5)
    expect(observed).toContainEqual({ cursor: 'head-fresh', maxAgeMs: 500, scenario: 'fresh' })
    const beforeFailedPrime = structuredClone(
      [...records.values()].find(({ arguments: value }) => value.scenario === 'fresh')
    )
    failRefreshPrime = true
    await expect(
      subscribeEventsWebhook(app, { ...freshParams, maxAgeMs: 333 }, options, context)
    ).rejects.toMatchObject({ code: -32603, message: 'UpstreamError' })
    failRefreshPrime = false
    expect(
      [...records.values()].find(({ arguments: value }) => value.scenario === 'fresh')
    ).toEqual(beforeFailedPrime)

    const staleArguments = { scenario: 'stale' }
    const staleCursor = encodeEventCursor(
      'old-stale',
      'com.example.prime',
      staleArguments,
      authorization,
      undefined,
      { signingKey, ttlMs: 1 }
    )
    await Bun.sleep(2)
    const stale = await subscribeEventsWebhook(
      app,
      {
        name: 'com.example.prime',
        arguments: staleArguments,
        cursor: staleCursor,
        maxAgeMs: 250,
        delivery: {
          mode: 'webhook',
          url: 'https://127.0.0.1:1/stale',
          secret
        }
      },
      options,
      context
    )
    expect(stale.truncated).toBe(true)
    expect(
      decodeEventCursor(
        stale.cursor,
        'com.example.prime',
        staleArguments,
        authorization,
        undefined,
        { signingKey, ttlMs: 1 }
      ).cursor
    ).toBe('head-stale')
    expect(observed).toContainEqual({ cursor: null, maxAgeMs: 250, scenario: 'stale' })

    await unsubscribeEventsWebhook(
      app,
      {
        name: freshParams.name,
        arguments: freshParams.arguments,
        delivery: { url: freshParams.delivery.url }
      },
      options,
      context
    )
    await unsubscribeEventsWebhook(
      app,
      {
        name: 'com.example.prime',
        arguments: staleArguments,
        delivery: { url: 'https://127.0.0.1:1/stale' }
      },
      options,
      context
    )
  })

  test('delivers a new webhook subscription replay batch before advancing its safe cursor', async () => {
    const records = new Map<string, McpWebhookSubscriptionRecord>()
    const seenCursors: Array<string | null> = []
    const seenMaxAges: number[] = []
    const authorization = {
      principal: {
        tokenType: 'access_token' as const,
        subject: 'replay-owner',
        audience: 'mcp',
        expiresAt: Math.floor(Date.now() / 1000) + 60,
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
    const options = normalizeOptions({
      transport: { protocolVersions: ['2025-11-25'] },
      extensions: {
        events: {
          cursor: { signingKey },
          pollIntervalMs: 5,
          maxEvents: 2,
          maxAgeMs: 10_000,
          webhook: {
            provider,
            environment: 'development',
            allowPrivateAddresses: true,
            allowlist: () => true,
            resolveAddresses: async () => [{ address: '127.0.0.1', family: 4 }],
            maxAttempts: 1,
            requestTimeoutMs: 25,
            retryBaseMs: 1
          }
        }
      }
    })
    const app = new Elysia().use(withMcpMethods()).mcpEvent(
      {
        name: 'com.example.replay',
        description: 'Replay event',
        delivery: ['webhook'],
        inputSchema: { type: 'object', additionalProperties: false },
        payloadSchema: {
          type: 'object',
          properties: { sequence: { type: 'number' } },
          required: ['sequence'],
          additionalProperties: false
        }
      },
      ({ cursor, maxAgeMs }) => {
        seenCursors.push(cursor)
        if (maxAgeMs !== undefined) seenMaxAges.push(maxAgeMs)
        if (cursor !== 'start') return { events: [], cursor: 'cursor-2', nextPollMs: 5 }
        return {
          events: [
            {
              eventId: 'event-1',
              name: 'com.example.replay',
              timestamp: '2026-10-01T12:00:00Z',
              data: { sequence: 1 },
              cursor: 'cursor-1'
            },
            {
              eventId: 'event-2',
              name: 'com.example.replay',
              timestamp: '2026-10-01T12:00:01Z',
              data: { sequence: 2 },
              cursor: 'cursor-2'
            }
          ],
          cursor: 'cursor-2',
          hasMore: true,
          nextPollMs: 5
        }
      }
    )
    const context = {
      request: new Request('http://localhost/mcp'),
      protocolVersion: '2025-11-25' as const,
      authorization
    }
    const cursor = encodeEventCursor('start', 'com.example.replay', {}, authorization, undefined, {
      signingKey,
      ttlMs: 60_000
    })
    const url = 'https://127.0.0.1:1/replay'
    const result = await subscribeEventsWebhook(
      app,
      {
        name: 'com.example.replay',
        arguments: {},
        cursor,
        maxAgeMs: 1_000,
        ttlMs: 60_000,
        delivery: {
          mode: 'webhook',
          url,
          secret: `whsec_${Buffer.alloc(24, 12).toString('base64')}`
        }
      },
      options,
      context
    )
    expect(
      decodeEventCursor(result.cursor, 'com.example.replay', {}, authorization, undefined, {
        signingKey,
        ttlMs: 60_000
      }).cursor
    ).toBe('start')
    expect(records.values().next().value?.maxAgeMs).toBe(1_000)
    for (
      let attempt = 0;
      attempt < 40 && !records.values().next().value?.deliveryStatus?.lastError;
      attempt++
    )
      await Bun.sleep(5)
    expect(seenCursors[0]).toBe('start')
    expect(seenMaxAges[0]).toBe(1_000)
    expect(records.values().next().value?.deliveryStatus?.lastError).toBe('connection_refused')
    await unsubscribeEventsWebhook(
      app,
      { name: 'com.example.replay', arguments: {}, delivery: { url } },
      options,
      context
    )
  })

  test('publishes truncated batch cursors only after earlier deliveries are handled', async () => {
    const fixture = new URL('./fixtures/events-replay-runner.ts', import.meta.url)
    const ca = new URL('./fixtures/events-network/ca.pem', import.meta.url)
    const child = Bun.spawn([process.execPath, fixture.pathname], {
      cwd: import.meta.dir,
      env: { ...process.env, NODE_EXTRA_CA_CERTS: ca.pathname },
      stdout: 'pipe',
      stderr: 'pipe'
    })
    const deadline = setTimeout(() => child.kill(), 2_000)
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited
    ]).finally(() => clearTimeout(deadline))
    expect(exitCode, stderr).toBe(0)
    expect(JSON.parse(stdout.trim())).toEqual([
      { type: 'event-1', cursor: 'head' },
      { type: 'event-1', cursor: 'head' },
      { type: 'event-2', cursor: 'cursor-1' },
      { type: 'event-3', cursor: 'batch-end' },
      { type: 'event-4', cursor: 'cursor-3' },
      { type: 'gap', cursor: 'second-batch-end' },
      { type: 'refresh', cursor: 'batch-end' }
    ])
  })

  test('serializes webhook refresh, terminal cleanup, and unsubscribe without resurrection', async () => {
    const within = async <T>(promise: Promise<T>, label: string): Promise<T> =>
      await Promise.race([
        promise,
        Bun.sleep(500).then(() => {
          throw new Error(`Timed out waiting for ${label}`)
        })
      ])
    const records = new Map<string, McpWebhookSubscriptionRecord>()
    let polls = 0
    let terminate = false
    let setupCalls = 0
    let teardownCalls = 0
    let terminalObserved = () => {}
    let terminalReached = new Promise<void>((resolve) => {
      terminalObserved = resolve
    })
    let resolverBarrier:
      | { entered(): void; wait: Promise<void>; release: Promise<void> }
      | undefined
    const blockNextResolution = () => {
      let entered = () => {}
      let release = () => {}
      const wait = new Promise<void>((resolve) => {
        entered = resolve
      })
      const released = new Promise<void>((resolve) => {
        release = resolve
      })
      resolverBarrier = { entered, wait, release: released }
      return { wait, release }
    }
    const authorization = {
      principal: {
        tokenType: 'access_token' as const,
        subject: 'lifecycle-owner',
        audience: 'mcp',
        expiresAt: Math.floor(Date.now() / 1000) + 60,
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
            resolveAddresses: async () => {
              const barrier = resolverBarrier
              if (barrier) {
                resolverBarrier = undefined
                barrier.entered()
                await barrier.release
              }
              return [{ address: '127.0.0.1', family: 4 }]
            },
            maxAttempts: 1,
            requestTimeoutMs: 25,
            retryBaseMs: 1
          }
        }
      }
    })
    const app = new Elysia().use(withMcpMethods()).mcpEvent(
      {
        name: 'com.example.lifecycle',
        description: 'Lifecycle event',
        delivery: ['webhook'],
        inputSchema: { type: 'object', additionalProperties: false },
        payloadSchema: { type: 'object' },
        onSubscribe: () => {
          setupCalls++
        },
        onUnsubscribe: () => {
          teardownCalls++
        }
      },
      () => {
        polls++
        if (terminate) {
          terminalObserved()
          return {
            events: [],
            cursor: null,
            terminated: { code: -32011, message: 'NotFound', data: { kind: 'event' } }
          }
        }
        return { events: [], cursor: null, nextPollMs: 5 }
      }
    )
    const context = {
      request: new Request('http://localhost/mcp'),
      protocolVersion: '2025-11-25' as const,
      authorization
    }
    const url = 'https://callback.test:1/lifecycle'
    const params = {
      name: 'com.example.lifecycle',
      arguments: {},
      cursor: null,
      ttlMs: 60_000,
      delivery: {
        mode: 'webhook',
        url,
        secret: `whsec_${Buffer.alloc(24, 13).toString('base64')}`
      }
    }
    await subscribeEventsWebhook(app, params, options, context)
    expect(setupCalls).toBe(1)
    for (let attempt = 0; attempt < 20 && polls === 0; attempt++) await Bun.sleep(5)

    const firstBarrier = blockNextResolution()
    const refreshedSecret = `whsec_${Buffer.alloc(24, 14).toString('base64')}`
    const refresh = subscribeEventsWebhook(
      app,
      { ...params, delivery: { ...params.delivery, secret: refreshedSecret } },
      options,
      context
    )
    await within(
      Promise.race([
        firstBarrier.wait,
        refresh.then(
          () => {
            throw new Error('First refresh completed before verification barrier')
          },
          (error) => {
            throw error
          }
        )
      ]),
      'first refresh verification'
    )
    terminate = true
    await within(terminalReached, 'stale worker termination')
    await Bun.sleep(10)
    terminate = false
    firstBarrier.release()
    await within(refresh, 'first refresh completion')
    await Bun.sleep(10)
    expect(records.size).toBe(1)
    expect(records.values().next().value?.secret).toBe(refreshedSecret)
    expect(setupCalls).toBe(2)
    expect(teardownCalls).toBe(1)

    terminalReached = new Promise<void>((resolve) => {
      terminalObserved = resolve
    })
    const secondBarrier = blockNextResolution()
    const secondRefresh = subscribeEventsWebhook(app, params, options, context)
    await within(secondBarrier.wait, 'second refresh verification')
    const unsubscribe = unsubscribeEventsWebhook(
      app,
      { name: params.name, arguments: {}, delivery: { url } },
      options,
      context
    )
    secondBarrier.release()
    await within(Promise.all([secondRefresh, unsubscribe]), 'refresh and unsubscribe serialization')
    expect(records.size).toBe(0)
    expect(setupCalls).toBe(2)
    expect(teardownCalls).toBe(2)
    await Bun.sleep(10)
    expect(records.size).toBe(0)
    expect(teardownCalls).toBe(2)

    terminalReached = new Promise<void>((resolve) => {
      terminalObserved = resolve
    })
    terminate = false
    await subscribeEventsWebhook(app, params, options, context)
    expect(setupCalls).toBe(3)
    terminate = true
    await within(terminalReached, 'terminal teardown')
    for (let attempt = 0; attempt < 40 && teardownCalls === 2; attempt++) await Bun.sleep(5)
    expect(records.size).toBe(0)
    expect(teardownCalls).toBe(3)
    await Bun.sleep(10)
    expect(teardownCalls).toBe(3)
  })

  test('recovers a durable subscription without persisting its client cursor', async () => {
    let polls = 0
    let restarts = 0
    const seenMaxAges: number[] = []
    const records = new Map<string, McpWebhookSubscriptionRecord>()
    const authorization = {
      principal: {
        tokenType: 'access_token' as const,
        subject: 'restart-owner',
        audience: 'mcp',
        expiresAt: Math.floor(Date.now() / 1000) + 60,
        scopes: []
      },
      scopes: [],
      attributes: {}
    }
    const provider: McpWebhookSubscriptionProvider = {
      durability: 'durable',
      get: (key) => records.get(key) ?? null,
      upsert: (record) => {
        records.set(record.key, structuredClone(record))
        return { record, created: false }
      },
      delete: (key) => records.delete(key),
      list: async function* () {
        yield* records.values()
      },
      authorizeDelivery: () => authorization
    }
    const options = normalizeOptions({
      transport: { protocolVersions: ['2025-11-25'] },
      extensions: {
        events: {
          cursor: { signingKey },
          pollIntervalMs: 5,
          maxAgeMs: 5_000,
          webhook: {
            provider,
            allowlist: () => true,
            resolveAddresses: async () => [{ address: '8.8.8.8', family: 4 }]
          }
        }
      }
    })
    const app = new Elysia().use(withMcpMethods()).mcpEvent(
      {
        name: 'com.example.restart',
        description: 'Restart event',
        delivery: ['webhook'],
        inputSchema: { type: 'object', additionalProperties: false },
        payloadSchema: { type: 'object' },
        onSubscribe: () => {
          restarts++
        }
      },
      ({ maxAgeMs }) => {
        polls++
        if (maxAgeMs !== undefined) seenMaxAges.push(maxAgeMs)
        return { events: [], cursor: 'new-head', nextPollMs: 5 }
      }
    )
    const principal = eventPrincipalKey(authorization)
    if (!principal) throw new Error('Test principal is unavailable')
    const url = 'https://events.example.test/restart'
    const identity = deriveWebhookSubscriptionIdentity(
      principal,
      url,
      'com.example.restart',
      {},
      signingKey
    )
    records.set(identity.key, {
      ...identity,
      principal,
      name: 'com.example.restart',
      arguments: {},
      maxAgeMs: 1_234,
      url,
      secret: `whsec_${Buffer.alloc(24, 9).toString('base64')}`,
      refreshBefore: new Date(Date.now() + 60_000).toISOString(),
      verified: true,
      active: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    })
    recoverWebhookSubscriptions(app, options)
    for (let attempt = 0; attempt < 20 && polls === 0; attempt++) await Bun.sleep(5)
    expect(restarts).toBe(1)
    expect(polls).toBeGreaterThan(0)
    expect(seenMaxAges[0]).toBe(1_234)
    expect(records.values().next().value).not.toHaveProperty('cursor')
    await unsubscribeEventsWebhook(
      app,
      { name: 'com.example.restart', arguments: {}, delivery: { url } },
      options,
      {
        request: new Request('http://localhost/mcp'),
        protocolVersion: '2025-11-25',
        authorization
      }
    )
  })
})
