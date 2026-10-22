import { describe, expect, test } from 'bun:test'
import { Elysia } from 'elysia'
import {
  MCP_EVENTS_LATEST_REVISION,
  MCP_EVENTS_REVISION,
  McpEventProtocolError,
  mcp,
  streamEvents,
  type McpEventsRevision,
  type McpEventError,
  type McpEventProvider
} from '../src/index.js'
import { normalizeOptions } from '../src/options.js'
import { within } from './events-test-helpers.js'
import { rpc } from './helpers.js'

const signingKey = 'events-revision-tests-signing-key-more-than-32-bytes'
const definition = {
  name: 'revision.changed',
  description: 'Revision boundary fixture',
  delivery: ['poll', 'push'] as ('poll' | 'push')[],
  inputSchema: { type: 'object' },
  payloadSchema: { type: 'object' }
}
const context = {
  request: new Request('http://localhost/mcp'),
  protocolVersion: '2025-11-25' as const
}
const params = { name: definition.name, arguments: {}, cursor: null }
const messages = [
  'NotFound',
  'Forbidden',
  'ResourceExhausted',
  'Unsupported',
  'CallbackEndpointError'
]

function configuration(version: McpEventsRevision, provider?: McpEventProvider) {
  return {
    allowedRoutes: [],
    transport: { protocolVersions: ['2025-11-25' as const] },
    extensions: {
      events: {
        version,
        cursor: { signingKey },
        provider,
        pollIntervalMs: 1,
        ...(provider ? { pagination: { signingKey, pageSize: 10 } } : {})
      }
    }
  }
}

describe('Events revision error boundaries', () => {
  test('selects the accepted latest revision for current', () => {
    expect(
      normalizeOptions({
        ...configuration(MCP_EVENTS_REVISION),
        extensions: { events: { version: 'current', cursor: { signingKey } } }
      }).extensions.events?.version
    ).toBe(MCP_EVENTS_LATEST_REVISION)
  })

  for (const version of [MCP_EVENTS_REVISION, MCP_EVENTS_LATEST_REVISION]) {
    const firstCode = version === MCP_EVENTS_LATEST_REVISION ? -32023 : -32011
    test(`${version} normalizes provider termination and thrown protocol codes in both vocabularies`, async () => {
      for (const suppliedFirstCode of [-32011, -32023]) {
        for (let index = 0; index < messages.length; index++) {
          const error: McpEventError = {
            code: suppliedFirstCode - index,
            message: messages[index]!,
            data: { fixture: index }
          }
          for (const thrown of [false, true]) {
            const provider: McpEventProvider = {
              list: () => ({ events: [definition] }),
              get: () => definition,
              poll: () => {
                if (thrown) throw new McpEventProtocolError(error.code, error.message, error.data)
                return { events: [], cursor: null, terminated: error }
              }
            }
            const app = new Elysia().use(mcp(configuration(version, provider)))
            const response = await rpc(app, 'events/poll', params)
            expect(response.body.error).toEqual({ ...error, code: firstCode - index })
            if (!thrown) {
              await expect(
                streamEvents(
                  app,
                  params,
                  80,
                  normalizeOptions(configuration(version, provider)),
                  context
                )
              ).rejects.toMatchObject({ ...error, code: firstCode - index })
            }
          }
        }
      }
    })

    test(`${version} preserves request validation, authorization, and successful polling`, async () => {
      const app = new Elysia()
        .use(mcp(configuration(version)))
        .mcpEvent(definition, () => ({ events: [], cursor: null }))
        .mcpEvent({ ...definition, name: 'private.changed', authorize: () => false }, () => ({
          events: [],
          cursor: null
        }))
      expect((await rpc(app, 'events/poll', params)).body.result.events).toEqual([])
      expect((await rpc(app, 'events/poll', { ...params, name: 'missing' })).body.error.code).toBe(
        firstCode
      )
      expect(
        (await rpc(app, 'events/poll', { ...params, name: 'private.changed' })).body.error.code
      ).toBe(firstCode - 1)
      expect(
        (await rpc(app, 'events/poll', { ...params, cursor: 'forged.cursor' })).body.error.code
      ).toBe(-32602)
      expect((await rpc(app, 'events/subscribe', params)).body.error.code).toBe(firstCode - 3)
    })

    test(`${version} sanitizes provider list, get and poll failures`, async () => {
      for (const operation of ['list', 'get', 'poll']) {
        const fail = () => {
          throw new Error('secret-provider-credential')
        }
        const provider: McpEventProvider = {
          list: operation === 'list' ? fail : () => ({ events: [definition] }),
          get: operation === 'get' ? fail : () => definition,
          poll: operation === 'poll' ? fail : () => ({ events: [], cursor: null })
        }
        const app = new Elysia().use(mcp(configuration(version, provider)))
        const response = await rpc(
          app,
          operation === 'list' ? 'events/list' : 'events/poll',
          params
        )
        expect(response.body.error).toEqual({ code: -32603, message: 'UpstreamError' })
      }
    })

    test(`${version} translates asynchronous SSE termination without altering payloads`, async () => {
      for (let index = 0; index < messages.length; index++) {
        let polls = 0
        const app = new Elysia().use(mcp(configuration(version))).mcpEvent(definition, () =>
          ++polls === 1
            ? { events: [], cursor: null }
            : {
                events: [],
                cursor: null,
                terminated: { code: -32011 - index, message: messages[index]! }
              }
        )
        const response = await streamEvents(
          app,
          params,
          81,
          normalizeOptions(configuration(version)),
          context
        )
        const reader = response.body!.getReader()
        let content = ''
        try {
          while (!content.includes('notifications/events/terminated')) {
            const item = await within(reader.read(), 'revision termination')
            if (item.done) break
            content += new TextDecoder().decode(item.value)
          }
          const terminated = content
            .split('\n')
            .filter((line) => line.startsWith('data: '))
            .map((line) => JSON.parse(line.slice(6)))
            .find((item) => item.method === 'notifications/events/terminated')
          expect(terminated.params.error).toEqual({
            code: firstCode - index,
            message: messages[index]
          })
        } finally {
          await reader.cancel()
        }
      }
    })

    test(`${version} emits revision-aware webhooks and callback and quota errors`, async () => {
      const child = Bun.spawn(
        [
          process.execPath,
          new URL('./fixtures/events-revisions-runner.ts', import.meta.url).pathname,
          version
        ],
        {
          env: {
            ...process.env,
            NODE_EXTRA_CA_CERTS: new URL('./fixtures/events-network/ca.pem', import.meta.url)
              .pathname
          },
          stdout: 'pipe',
          stderr: 'pipe'
        }
      )
      const timer = setTimeout(() => child.kill(), 5_000)
      try {
        const [output, diagnostics, exitCode] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited
        ])
        expect(exitCode, diagnostics).toBe(0)
        const result = JSON.parse(output)
        expect(result.codes).toEqual(messages.map((_, index) => firstCode - index))
        expect(result.callback).toEqual({
          code: firstCode - 4,
          message: 'CallbackEndpointError',
          data: { reason: 'connection_refused' }
        })
        expect(result.quota).toEqual({
          code: firstCode - 2,
          message: 'ResourceExhausted',
          data: { limit: 'subscriptions', max: 100 }
        })
        expect(result.records).toBe(0)
      } finally {
        clearTimeout(timer)
        child.kill()
        await child.exited
      }
    })
  }
})
