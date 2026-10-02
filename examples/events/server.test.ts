import { describe, expect, test } from 'bun:test'
import { createHmac } from 'node:crypto'
import { rmSync } from 'node:fs'
import type { EventStreamMethod } from './client.js'
import {
  parseEventStream,
  refreshWebhook,
  rpc,
  stream,
  subscribeWebhook,
  unsubscribeWebhook
} from './client.js'
import { InMemoryEventHistory } from './event-source.js'
import { SqliteWebhookProvider } from './provider.js'
import { challengeResponse, StandardWebhookReceiver } from './receiver.js'
import { app, publishBuildUpdate } from './server.js'
import { createWebhookEventApp } from './webhook-server.js'

const database = `${import.meta.dir}/events-test.sqlite`

describe('events example', () => {
  test('lists, polls with a client-owned cursor, and streams event-only SSE', async () => {
    const listed = await rpc(app, 'events/list')
    expect(listed.body.result.events[0].name).toBe('com.example.build.changed')
    const fresh = await rpc(app, 'events/poll', {
      name: 'com.example.build.changed',
      arguments: { project: 'adapter' },
      cursor: null
    })
    expect(fresh.body.result.events).toEqual([])
    publishBuildUpdate('adapter', 1)
    const replay = await rpc(app, 'events/poll', {
      name: 'com.example.build.changed',
      arguments: { project: 'adapter' },
      cursor: fresh.body.result.cursor
    })
    expect(replay.body.result.events).toHaveLength(1)
    const abort = new AbortController()
    const response = await stream(
      app,
      { name: 'com.example.build.changed', arguments: { project: 'adapter' }, cursor: null },
      abort.signal
    )
    const reader = response.body?.getReader()
    if (!reader) throw new Error('Missing SSE body')
    const first = new TextDecoder().decode((await reader.read()).value)
    expect(first).toContain('notifications/events/active')
    expect(first).not.toContain('notifications/tools')
    abort.abort()
    await reader.cancel()
  })

  test('replays stable retained events, advances cursors, filters, and reports history gaps', async () => {
    let now = Date.now()
    const history = new InMemoryEventHistory(2, () => now)
    const handler = history.handler(5)
    const context = { request: new Request('http://localhost') } as never
    const head = await handler(
      {
        name: 'com.example.build.changed',
        arguments: { project: 'a' },
        cursor: null,
        maxEvents: 10
      },
      context
    )
    const first = history.publish('com.example.build.changed', { sequence: 1 }, 'a')
    history.publish('com.example.build.changed', { sequence: 2 }, 'b')
    const replay = await handler(
      {
        name: 'com.example.build.changed',
        arguments: { project: 'a' },
        cursor: head.cursor,
        maxEvents: 10
      },
      context
    )
    const repeated = await handler(
      {
        name: 'com.example.build.changed',
        arguments: { project: 'a' },
        cursor: head.cursor,
        maxEvents: 10
      },
      context
    )
    expect(replay.events.map(({ eventId }) => eventId)).toEqual([first.eventId])
    expect(repeated.events.map(({ eventId }) => eventId)).toEqual([first.eventId])
    const acknowledged = await handler(
      {
        name: 'com.example.build.changed',
        arguments: { project: 'a' },
        cursor: replay.cursor,
        maxEvents: 10
      },
      context
    )
    expect(acknowledged.events).toEqual([])
    now += 1
    const agedOut = await handler(
      {
        name: 'com.example.build.changed',
        arguments: { project: 'b' },
        cursor: head.cursor,
        maxAgeMs: 0,
        maxEvents: 10
      },
      context
    )
    expect(agedOut).toMatchObject({ events: [], truncated: true })
    history.publish('com.example.build.changed', { sequence: 3 }, 'a')
    const gap = await handler(
      {
        name: 'com.example.build.changed',
        arguments: { project: 'a' },
        cursor: head.cursor,
        maxEvents: 10
      },
      context
    )
    expect(gap).toMatchObject({ events: [], truncated: true })
    const staleEpoch = await handler(
      {
        name: 'com.example.build.changed',
        arguments: { project: 'a' },
        cursor: `stale:${Number.MAX_SAFE_INTEGER}`,
        maxEvents: 10
      },
      context
    )
    expect(staleEpoch).toMatchObject({ events: [], truncated: true })
  })

  test('persists subscription state across provider restart and rechecks authorization', async () => {
    rmSync(database, { force: true })
    rmSync(`${database}-wal`, { force: true })
    rmSync(`${database}-shm`, { force: true })
    let permitted = true
    const authorize = () =>
      permitted
        ? {
            principal: {
              tokenType: 'access_token' as const,
              subject: 'owner',
              audience: 'mcp',
              expiresAt: 4_102_444_800,
              scopes: []
            },
            scopes: [],
            attributes: {}
          }
        : false
    const record = {
      key: 'owner/sub',
      id: 'sub',
      principal: 'owner',
      name: 'event',
      arguments: {},
      url: 'https://callback.test/hook',
      secret: 'whsec_AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEB',
      refreshBefore: new Date(Date.now() + 60_000).toISOString(),
      verified: true,
      active: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }
    const first = new SqliteWebhookProvider(database, authorize)
    expect(first.upsert(record, { maxSubscriptionsPerPrincipal: 1 })).toMatchObject({
      created: true
    })
    expect(
      first.upsert(
        { ...record, key: 'owner/second', id: 'second' },
        { maxSubscriptionsPerPrincipal: 1 }
      )
    ).toEqual({ limitExceeded: true })
    expect(() =>
      first.upsert({ ...record, principal: 'attacker' }, { maxSubscriptionsPerPrincipal: 2 })
    ).toThrow('ownership')
    first.close()
    const restarted = new SqliteWebhookProvider(database, authorize)
    expect(restarted.durability).toBe('durable')
    expect(restarted.get(record.key)).toMatchObject({
      id: 'sub',
      verified: true,
      secret: record.secret
    })
    expect(await restarted.authorizeDelivery(record)).not.toBe(false)
    permitted = false
    expect(await restarted.authorizeDelivery(record)).toBe(false)
    const listed = []
    for await (const stored of restarted.list()) listed.push(stored.id)
    expect(listed).toEqual(['sub'])
    expect(restarted.delete(record.key)).toBe(true)
    restarted.close()
  })

  test('recovers durable records in a separate Bun process and runs a real TLS receiver', async () => {
    const run = async (...arguments_: string[]) => {
      const child = Bun.spawn([process.execPath, ...arguments_], {
        cwd: import.meta.dir,
        env: {
          ...process.env,
          NODE_EXTRA_CA_CERTS: `${import.meta.dir}/fixtures/ca.pem`
        },
        stdout: 'pipe',
        stderr: 'pipe'
      })
      const deadline = setTimeout(() => child.kill(), 2_000)
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited
      ]).finally(() => clearTimeout(deadline))
      expect(code, stderr).toBe(0)
      return stdout
    }
    rmSync(database, { force: true })
    rmSync(`${database}-wal`, { force: true })
    rmSync(`${database}-shm`, { force: true })
    expect(await run('provider-process.ts', 'write', database)).toContain('written')
    expect(JSON.parse(await run('provider-process.ts', 'read', database))).toMatchObject({
      id: 'restart',
      verified: true,
      refreshBefore: null
    })
    rmSync(database, { force: true })
    rmSync(`${database}-wal`, { force: true })
    rmSync(`${database}-shm`, { force: true })
    new SqliteWebhookProvider(database, () => false).close()
    const claims = await Promise.all([
      run('provider-process.ts', 'claim', database, 'first', 'owner'),
      run('provider-process.ts', 'claim', database, 'second', 'owner')
    ])
    expect(
      claims.map((value) => JSON.parse(value)).filter((value) => value.limitExceeded)
    ).toHaveLength(1)
    rmSync(database, { force: true })
    rmSync(`${database}-wal`, { force: true })
    rmSync(`${database}-shm`, { force: true })
  })

  test('subscribes, rotates, restarts adapter recovery, delivers, and unsubscribes over TLS', async () => {
    const lifecycleDatabase = `${import.meta.dir}/events-lifecycle.sqlite`
    const receiverLog = `${import.meta.dir}/events-receiver.jsonl`
    const fixtureAccessToken = `fixture-${crypto.randomUUID()}`
    for (const path of [
      lifecycleDatabase,
      `${lifecycleDatabase}-wal`,
      `${lifecycleDatabase}-shm`,
      receiverLog
    ])
      rmSync(path, { force: true })
    const receiver = Bun.spawn([process.execPath, 'fixture-receiver.ts', receiverLog], {
      cwd: import.meta.dir,
      stdout: 'pipe',
      stderr: 'pipe'
    })
    try {
      const reader = receiver.stdout.getReader()
      const firstChunk = await Promise.race([
        reader.read(),
        Bun.sleep(2_000).then(() => {
          throw new Error('Receiver startup timed out')
        })
      ])
      const port = Number(new TextDecoder().decode(firstChunk.value).trim())
      expect(port).toBeGreaterThan(0)
      const runAdapter = async (mode: 'subscribe' | 'recover') => {
        const child = Bun.spawn(
          [
            process.execPath,
            'webhook-process.ts',
            mode,
            lifecycleDatabase,
            `https://callback.test:${port}/events`,
            receiverLog
          ],
          {
            cwd: import.meta.dir,
            env: {
              ...process.env,
              NODE_EXTRA_CA_CERTS: `${import.meta.dir}/fixtures/ca.pem`,
              EVENTS_FIXTURE_ACCESS_TOKEN: fixtureAccessToken
            },
            stdout: 'pipe',
            stderr: 'pipe'
          }
        )
        const deadline = setTimeout(() => child.kill(), 3_000)
        const [stdout, stderr, code] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited
        ]).finally(() => clearTimeout(deadline))
        expect(code, stderr).toBe(0)
        return JSON.parse(stdout.trim())
      }
      const subscription = await runAdapter('subscribe')
      const observedAt = Date.parse(subscription.observedAt)
      const minimumGrantMs = Date.parse(subscription.minimumRefreshBefore) - observedAt
      const maximumGrantMs = Date.parse(subscription.maximumRefreshBefore) - observedAt
      expect(subscription).toMatchObject({
        subscribed: expect.any(String),
        refreshed: expect.any(String),
        freshCursor: expect.any(String),
        freshTruncated: false,
        observedAt: expect.any(String),
        minimumRefreshBefore: expect.any(String),
        maximumRefreshBefore: expect.any(String)
      })
      expect(minimumGrantMs).toBeGreaterThan(25_000)
      expect(minimumGrantMs).toBeLessThanOrEqual(30_000)
      expect(maximumGrantMs).toBeGreaterThan(115_000)
      expect(maximumGrantMs).toBeLessThanOrEqual(120_000)
      const stored = new SqliteWebhookProvider(lifecycleDatabase, () => false)
      const records = []
      for await (const record of stored.list()) records.push(record)
      expect(records).toHaveLength(1)
      expect(records[0]).not.toHaveProperty('cursor')
      expect(records[0]?.maxAgeMs).toBe(15_000)
      stored.close()
      expect(await runAdapter('recover')).toEqual({ recovered: true, removed: true })
      const deliveries = (await Bun.file(receiverLog).text())
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
      expect(deliveries.filter(({ kind }) => kind === 'challenge').length).toBeGreaterThanOrEqual(1)
      expect(
        deliveries.filter(({ kind, duplicate }) => kind === 'event' && !duplicate).length
      ).toBeGreaterThanOrEqual(2)
      expect(
        deliveries.some(({ signature }) => typeof signature === 'string' && signature.includes(' '))
      ).toBe(true)
      const persisted = new SqliteWebhookProvider(lifecycleDatabase, () => false)
      const remaining = []
      for await (const record of persisted.list()) remaining.push(record)
      expect(remaining).toEqual([])
      persisted.close()
    } finally {
      receiver.kill()
      await receiver.exited
      for (const path of [
        lifecycleDatabase,
        `${lifecycleDatabase}-wal`,
        `${lifecycleDatabase}-shm`,
        receiverLog
      ])
        rmSync(path, { force: true })
    }
  })

  test('rejects unknown bearer credentials and delegates delivery reauthorization', async () => {
    const authDatabase = `${import.meta.dir}/events-auth.sqlite`
    for (const path of [authDatabase, `${authDatabase}-wal`, `${authDatabase}-shm`])
      rmSync(path, { force: true })
    let deliveryAuthorized = true
    const accessToken = `fixture-${crypto.randomUUID()}`
    const { app: authenticated, provider } = createWebhookEventApp(authDatabase, {
      accessToken,
      authorizeDelivery: (_storedPrincipal, authorization) =>
        deliveryAuthorized && authorization.principal.subject === 'owner'
    })
    const rejected = await rpc(authenticated, 'events/list', {}, 'Bearer wrong-token')
    expect(rejected.response.status).toBe(401)
    expect(rejected.body.error).toBe('invalid_token')
    const missing = await rpc(authenticated, 'events/list')
    expect(missing.response.status).toBe(401)
    expect(missing.body.error).toBe('invalid_token')
    expect(
      await provider.authorizeDelivery({
        principal: '["https://auth.example.test","owner",null]'
      } as never)
    ).not.toBe(false)
    deliveryAuthorized = false
    expect(
      await provider.authorizeDelivery({
        principal: '["https://auth.example.test","owner",null]'
      } as never)
    ).toBe(false)
    expect(await provider.authorizeDelivery({ principal: '[null,"attacker",null]' } as never)).toBe(
      false
    )
    provider.close()
    for (const path of [authDatabase, `${authDatabase}-wal`, `${authDatabase}-shm`])
      rmSync(path, { force: true })
  })

  test('verifies exact raw bytes, timestamp, deduplication, dual signatures, and challenge echo', () => {
    const body = Uint8Array.from([0xff, 0xfe, 0x00, 0x61])
    const timestamp = String(Math.floor(Date.now() / 1000))
    const id = `event-${crypto.randomUUID()}`
    const secrets = [
      'whsec_AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEB',
      'whsec_AgICAgICAgICAgICAgICAgICAgICAgIC'
    ]
    const signedHeaders = (messageId: string) => {
      const signed = Buffer.concat([Buffer.from(`${messageId}.${timestamp}.`), body])
      const signatures = secrets
        .map(
          (secret) =>
            `v1,${createHmac('sha256', Buffer.from(secret.slice(6), 'base64'))
              .update(signed)
              .digest('base64')}`
        )
        .join(' ')
      return new Headers({
        'webhook-id': messageId,
        'webhook-timestamp': timestamp,
        'webhook-signature': signatures
      })
    }
    const headers = signedHeaders(id)
    const receiver = new StandardWebhookReceiver({ maxEntries: 2, dedupTtlMs: 1_000 })
    expect(receiver.verify(body, headers, secrets)).toEqual({ accepted: true, duplicate: false })
    expect(receiver.verify(body, headers, secrets)).toEqual({ accepted: true, duplicate: true })
    expect(receiver.verify(body, headers, secrets, Date.now() + 2_000)).toEqual({
      accepted: true,
      duplicate: false
    })
    const bounded = new StandardWebhookReceiver({ maxEntries: 1 })
    expect(bounded.verify(body, signedHeaders('first'), secrets).duplicate).toBe(false)
    expect(bounded.verify(body, signedHeaders('second'), secrets).duplicate).toBe(false)
    expect(bounded.verify(body, signedHeaders('first'), secrets).duplicate).toBe(false)
    for (const malformed of ['1.5', 'NaN', '+1', '9007199254740992'])
      expect(
        receiver.verify(
          body,
          new Headers({ ...Object.fromEntries(headers), 'webhook-timestamp': malformed }),
          secrets
        ).accepted
      ).toBe(false)
    expect(
      receiver.verify(
        body,
        {
          get: (name: string) =>
            name === 'webhook-signature' ? '💣'.repeat(24) : headers.get(name)
        } as Headers,
        secrets
      ).accepted
    ).toBe(false)
    expect(
      receiver.verify(
        body,
        new Headers({ ...Object.fromEntries(headers), 'webhook-timestamp': '1' }),
        secrets
      ).accepted
    ).toBe(false)
    expect(
      challengeResponse(new TextEncoder().encode('{"type":"verification","challenge":"proof"}'))
    ).toEqual({ challenge: 'proof' })
  })

  test('builds the original webhook tuple and recognizes every event-only SSE message', async () => {
    const requests: Array<{ method: string; params: Record<string, unknown> }> = []
    const transport = {
      handle: async (request: Request) => {
        const body = (await request.json()) as { method: string; params: Record<string, unknown> }
        requests.push(body)
        return Response.json({ jsonrpc: '2.0', id: 1, result: {} })
      }
    } as unknown as typeof app
    const tuple = {
      name: 'com.example.build.changed',
      arguments: { project: 'adapter' },
      url: 'https://callback.test/events'
    }
    await subscribeWebhook(transport, tuple, 'whsec_AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEB', null, 60_000)
    await refreshWebhook(
      transport,
      tuple,
      'whsec_AgICAgICAgICAgICAgICAgICAgICAgIC',
      'client-cursor',
      null
    )
    await unsubscribeWebhook(transport, tuple)
    expect(requests.map(({ method }) => method)).toEqual([
      'events/subscribe',
      'events/subscribe',
      'events/unsubscribe'
    ])
    expect(requests[2]?.params).toMatchObject({
      name: tuple.name,
      arguments: tuple.arguments,
      delivery: { url: tuple.url }
    })
    const methods: EventStreamMethod[] = [
      'notifications/events/active',
      'notifications/events/event',
      'notifications/events/heartbeat',
      'notifications/events/error',
      'notifications/events/terminated'
    ]
    const parsed = parseEventStream(
      methods
        .map((method) => `data: ${JSON.stringify({ jsonrpc: '2.0', method, params: {} })}\n\n`)
        .join('')
    )
    expect(parsed.map(({ method }) => method)).toEqual(methods)
  })
})
