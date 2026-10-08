import { describe, expect, test } from 'bun:test'
import Ajv2020Import from 'ajv/dist/2020.js'
import addFormatsImport from 'ajv-formats'
import { Elysia } from 'elysia'
import {
  executeInterceptorChain,
  invokeInterceptor,
  LEGACY_PROTOCOL_VERSION,
  MCP_ACTION_METADATA_ID,
  MCP_SERVER_CARD_MIME_TYPE,
  MCP_SERVER_CARD_SCHEMA,
  MCP_SERVER_VARIANT_META_KEY,
  MCP_SERVER_VARIANTS_ID,
  MCP_TRUST_ANNOTATIONS_ID,
  type McpInterceptorRegistration,
  type McpServerNotification,
  mcp
} from '../src/index.js'
import serverCardSchema from './fixtures/server-card.schema.json' with { type: 'json' }
import { modernRpc } from './helpers.js'

const Ajv2020 = (Ajv2020Import as any).default ?? Ajv2020Import
const addFormats = (addFormatsImport as any).default ?? addFormatsImport

describe('experimental server contracts', () => {
  test('serves a schema-valid, consistent, cacheable CORS server card', async () => {
    const card = {
      $schema: MCP_SERVER_CARD_SCHEMA,
      name: 'com.example/test',
      description: 'Test server',
      version: 'release-2026.10',
      remotes: [
        {
          type: 'streamable-http' as const,
          url: 'https://example.com/mcp',
          supportedProtocolVersions: ['2026-07-28']
        }
      ]
    }
    const app = new Elysia().use(
      mcp({
        allowedRoutes: [],
        server: { name: card.name, version: card.version },
        extensions: { serverCard: { card, environment: 'development' } }
      })
    )
    const response = await app.handle(
      new Request('http://localhost/mcp/server-card', {
        headers: { accept: MCP_SERVER_CARD_MIME_TYPE }
      })
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain(MCP_SERVER_CARD_MIME_TYPE)
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
    expect(response.headers.get('cache-control')).toBe('public, max-age=3600')
    const etag = response.headers.get('etag')
    expect(etag).toBeTruthy()
    const body = await response.json()
    const ajv = new Ajv2020({ strict: false })
    addFormats(ajv)
    expect(ajv.validate({ ...serverCardSchema, $ref: '#/$defs/ServerCard' }, body)).toBe(true)
    const cached = await app.handle(
      new Request('http://localhost/mcp/server-card', {
        headers: { 'if-none-match': etag as string }
      })
    )
    expect(cached.status).toBe(304)

    const production = new Elysia().use(
      mcp({
        allowedRoutes: [],
        server: { name: card.name, version: card.version },
        extensions: { serverCard: { card } }
      })
    )
    expect(
      (await production.handle(new Request('http://internal-proxy/mcp/server-card'))).status
    ).toBe(200)
    expect(
      (await production.handle(new Request('https://example.com/mcp/server-card'))).status
    ).toBe(200)
  })

  test('validates the pinned card schema and rejects ranges, secrets, topology, and credentials', () => {
    const base = {
      $schema: MCP_SERVER_CARD_SCHEMA,
      name: 'com.example/test',
      description: 'Test server',
      version: '1.0.0'
    }
    expect(() =>
      mcp({
        server: { name: base.name, version: '1.0.0' },
        extensions: { serverCard: { card: { ...base, version: '^1.0.0' } } }
      })
    ).toThrow('exact string')
    expect(() =>
      mcp({
        server: { name: base.name, version: base.version },
        extensions: {
          serverCard: {
            card: {
              ...base,
              remotes: [
                {
                  type: 'streamable-http',
                  url: 'https://example.com',
                  headers: [{ name: 'Authorization', isSecret: true, value: 'token' }]
                }
              ]
            }
          }
        }
      })
    ).toThrow(/secret|credentials/u)
    expect(() =>
      mcp({
        server: { name: base.name, version: base.version },
        extensions: {
          serverCard: {
            card: { ...base, _meta: { 'com.example/token': 'embedded' } }
          }
        }
      })
    ).toThrow('credentials')
    for (const configuredBase of [
      'https://user:password@example.com',
      'https://127.0.0.1',
      'https://[fc00::1]',
      'https://[::ffff:7f00:1]',
      'https://service.internal'
    ]) {
      expect(() =>
        mcp({
          server: { name: base.name, version: base.version },
          extensions: {
            serverCard: {
              card: {
                ...base,
                remotes: [
                  {
                    type: 'streamable-http',
                    url: '{base}/mcp',
                    variables: { base: { default: configuredBase } }
                  }
                ]
              }
            }
          }
        })
      ).toThrow(/credentials|private topology/u)
    }
    expect(() =>
      mcp({
        server: { name: base.name, version: base.version },
        extensions: {
          serverCard: {
            card: {
              ...base,
              remotes: [
                {
                  type: 'streamable-http',
                  url: 'https://example.com',
                  headers: [{ name: 'Authorization', value: 'Bearer embedded' }]
                }
              ]
            }
          }
        }
      })
    ).toThrow('credentials')
    expect(() =>
      mcp({
        server: { name: base.name, version: base.version },
        extensions: {
          serverCard: {
            card: {
              ...base,
              remotes: [
                {
                  type: 'streamable-http',
                  url: 'https://example.com',
                  variables: { token: { isSecret: true, default: 'embedded' } }
                }
              ]
            }
          }
        }
      })
    ).toThrow(/secret|credentials/u)
    expect(() =>
      mcp({
        server: { name: base.name, version: base.version },
        extensions: {
          serverCard: {
            card: { ...base, remotes: [{ type: 'streamable-http', url: 'https://10.0.0.2/mcp' }] }
          }
        }
      })
    ).toThrow('private topology')
    expect(() =>
      mcp({
        server: { name: base.name, version: base.version },
        extensions: {
          serverCard: {
            card: {
              ...base,
              remotes: [{ type: 'streamable-http', url: 'https://user:password@example.com/mcp' }]
            }
          }
        }
      })
    ).toThrow('credentials')
    expect(() =>
      mcp({
        server: { name: base.name, version: base.version },
        extensions: {
          serverCard: {
            environment: 'development',
            card: {
              ...base,
              remotes: [{ type: 'streamable-http', url: 'http://[fc00::1]/mcp' }]
            }
          }
        }
      })
    ).toThrow('private topology')
    expect(() =>
      mcp({
        server: { name: base.name, version: base.version },
        extensions: { serverCard: { card: { ...base, tools: [] } as any } }
      })
    ).toThrow('must not expose tools')
    expect(() =>
      mcp({
        server: { name: base.name, version: base.version },
        extensions: {
          serverCard: {
            card: {
              ...base,
              icons: [{ src: 'https://example.com/icon.png', theme: 'invalid' }]
            } as any
          }
        }
      })
    ).toThrow('pinned schema')
    expect(() =>
      mcp({
        server: { name: base.name, version: 'live-version' },
        extensions: {
          serverCard: {
            card: {
              ...base,
              _meta: { 'com.example/public': { label: 'safe' } },
              icons: [{ src: 'data:image/png;base64,AA==' }]
            }
          }
        }
      })
    ).not.toThrow()
    expect(() =>
      mcp({
        server: { name: base.name, version: base.version },
        extensions: {
          serverCard: {
            card: {
              ...base,
              remotes: [
                {
                  type: 'streamable-http',
                  url: '{base}/mcp',
                  variables: { base: { description: 'Public MCP origin', isRequired: true } }
                }
              ]
            }
          }
        }
      })
    ).not.toThrow()
    expect(() =>
      mcp({
        server: { name: base.name, version: base.version },
        extensions: {
          serverCard: {
            card: {
              ...base,
              repository: {
                source: 'github',
                url: 'https://github.com/example/server',
                subfolder: 'packages/server'
              }
            }
          }
        }
      })
    ).not.toThrow()
    for (const subfolder of [
      '',
      '.',
      '..',
      '/server',
      'packages//server',
      'packages/../server',
      'packages\\server',
      'C:/server',
      '%2e%2e/server',
      'packages%2f..%2fserver',
      '%252e%252e/server'
    ]) {
      expect(() =>
        mcp({
          server: { name: base.name, version: base.version },
          extensions: {
            serverCard: {
              card: {
                ...base,
                repository: {
                  source: 'github',
                  url: 'https://github.com/example/server',
                  subfolder
                }
              }
            }
          }
        })
      ).toThrow('clean relative path')
    }
  })

  test('discovers and invokes interceptors with schema, timeout, and canonical method names', async () => {
    let nullableCalls = 0
    const app = new Elysia()
      .use(mcp({ allowedRoutes: [], extensions: { interceptors: {} } }))
      .mcpInterceptor(
        {
          name: 'nullable',
          version: '1',
          description: 'Accepts null payloads',
          type: 'validation',
          hooks: [{ events: ['tools/call'], phase: 'request' }]
        },
        ({ payload }) => {
          nullableCalls++
          return { valid: payload === null }
        }
      )
      .mcpInterceptor(
        {
          name: 'validate',
          version: '1.0.0',
          description: 'Validates names',
          type: 'validation',
          hooks: [{ events: ['tools/call'], phase: 'request' }],
          payloadSchema: { type: 'object', required: ['name'] }
        },
        ({ payload }) => ({ valid: (payload as any).name !== 'blocked', severity: 'error' })
      )
      .mcpInterceptor(
        {
          name: 'configured',
          version: '1',
          description: 'Requires configuration',
          type: 'validation',
          hooks: [{ events: ['resources/read'], phase: 'request' }],
          configSchema: { type: 'object', required: ['enabled'] }
        },
        () => ({ valid: true })
      )
      .mcpInterceptor(
        {
          name: 'throws',
          version: '1',
          description: 'Throws a handler TypeError',
          type: 'validation',
          hooks: [{ events: ['tools/call'], phase: 'request' }]
        },
        () => {
          throw new TypeError('secret token must never cross the wire')
        }
      )
      .mcpInterceptor(
        {
          name: 'bad-result',
          version: '1',
          description: 'Returns an invalid result',
          type: 'validation',
          hooks: [{ events: ['*'], phase: 'request' }]
        },
        () => ({ valid: 'yes' }) as any
      )
    const listed = await modernRpc(app, 'interceptors/list', { event: 'tools/call' })
    expect(listed.body.result.interceptors.map((entry: any) => entry.name)).toEqual([
      'nullable',
      'validate',
      'throws',
      'bad-result'
    ])
    const invoked = await modernRpc(app, 'interceptor/invoke', {
      name: 'validate',
      event: 'tools/call',
      phase: 'request',
      payload: { name: 'ok' }
    })
    expect(invoked.body.result.valid).toBe(true)
    expect(invoked.body.result).toMatchObject({
      interceptor: 'validate',
      type: 'validation',
      phase: 'request'
    })
    const missingPayload = await modernRpc(app, 'interceptor/invoke', {
      name: 'nullable',
      event: 'tools/call',
      phase: 'request'
    })
    expect(missingPayload.body.error.code).toBe(-32602)
    const emptyEvent = await modernRpc(app, 'interceptor/invoke', {
      name: 'nullable',
      event: '',
      phase: 'request',
      payload: null
    })
    expect(emptyEvent.body.error.code).toBe(-32602)
    expect(nullableCalls).toBe(0)
    const nullable = await modernRpc(app, 'interceptor/invoke', {
      name: 'nullable',
      event: 'tools/call',
      phase: 'request',
      payload: null
    })
    expect(nullable.body.result.valid).toBe(true)
    expect(nullableCalls).toBe(1)
    const plural = await modernRpc(app, 'interceptors/invoke', {})
    expect(plural.body.error.code).toBe(-32601)
    const discovery = await modernRpc(app, 'server/discover')
    expect(
      discovery.body.result.capabilities.extensions['io.modelcontextprotocol/interceptors']
    ).toEqual({ supportedEvents: ['*', 'resources/read', 'tools/call'] })

    const invalidConfig = await modernRpc(app, 'interceptor/invoke', {
      name: 'configured',
      event: 'resources/read',
      phase: 'request',
      payload: {},
      config: {}
    })
    expect(invalidConfig.body.error).toEqual({
      code: -32603,
      message: 'Interceptor execution failed',
      data: { interceptor: 'configured', reason: 'Configuration invalid' }
    })
    const handlerFailure = await modernRpc(app, 'interceptor/invoke', {
      name: 'throws',
      event: 'tools/call',
      phase: 'request',
      payload: {}
    })
    expect(handlerFailure.body.error).toEqual({
      code: -32603,
      message: 'Interceptor execution failed',
      data: { interceptor: 'throws', reason: 'Handler failed' }
    })
    expect(JSON.stringify(handlerFailure.body)).not.toContain('secret token')
    const invalidResult = await modernRpc(app, 'interceptor/invoke', {
      name: 'bad-result',
      event: 'tools/call',
      phase: 'request',
      payload: {}
    })
    expect(invalidResult.body.error).toEqual({
      code: -32603,
      message: 'Interceptor execution failed',
      data: { interceptor: 'bad-result', reason: 'Result invalid' }
    })
    const unsupportedEvent = await modernRpc(app, 'interceptor/invoke', {
      name: 'configured',
      event: 'tools/call',
      phase: 'request',
      payload: {},
      config: { enabled: true }
    })
    expect(unsupportedEvent.body.error.code).toBe(-32602)

    const legacy = new Elysia()
      .use(
        mcp({
          allowedRoutes: [],
          transport: {
            protocolVersion: LEGACY_PROTOCOL_VERSION,
            protocolVersions: [LEGACY_PROTOCOL_VERSION]
          },
          extensions: { interceptors: {} }
        })
      )
      .mcpInterceptor(
        {
          name: 'legacy',
          version: '1',
          description: 'Legacy capability',
          type: 'validation',
          hooks: [{ events: ['prompts/get', '*'], phase: 'response' }]
        },
        () => ({ valid: true })
      )
    const initialized = await legacyRequest(legacy, 'initialize', {
      protocolVersion: LEGACY_PROTOCOL_VERSION,
      clientInfo: { name: 'test', version: '1' },
      capabilities: {}
    })
    expect(
      initialized.body.result.capabilities.extensions['io.modelcontextprotocol/interceptors']
    ).toEqual({ supportedEvents: ['*', 'prompts/get'] })

    const timed = new Elysia()
      .use(mcp({ allowedRoutes: [], extensions: { interceptors: {} } }))
      .mcpInterceptor(
        {
          name: 'slow',
          version: '1',
          description: 'Times out',
          type: 'validation',
          hooks: [{ events: ['tools/call'], phase: 'request' }]
        },
        async (_invocation, context) => {
          await new Promise<void>((resolve) =>
            context.signal.addEventListener('abort', () => resolve(), { once: true })
          )
          return { valid: true }
        }
      )
    const timeout = await modernRpc(timed, 'interceptor/invoke', {
      name: 'slow',
      event: 'tools/call',
      phase: 'request',
      payload: {},
      timeoutMs: 1
    })
    expect(timeout.body.error).toMatchObject({ code: -32000, data: { interceptor: 'slow' } })
  })

  test('runs mutators sequentially, validators in parallel, audit shadowed, and failures closed', async () => {
    const registration = (
      name: string,
      type: 'mutation' | 'validation',
      handler: McpInterceptorRegistration['handler'],
      priorityHint = 0
    ): McpInterceptorRegistration => ({
      definition: {
        name,
        version: '1',
        description: name,
        type,
        hooks: [{ events: ['tools/call'], phase: 'request' }],
        priorityHint
      },
      handler
    })
    let directCalls = 0
    const direct = registration('direct', 'validation', () => {
      directCalls++
      return { valid: true }
    })
    await expect(
      invokeInterceptor(
        direct,
        { name: 'direct', event: '', phase: 'request', payload: null },
        { request: new Request('http://localhost') }
      )
    ).rejects.toThrow('event is required')
    await expect(
      executeInterceptorChain([{ registration: direct }], '', 'request', null, {
        request: new Request('http://localhost')
      })
    ).rejects.toThrow('event is required')
    expect(directCalls).toBe(0)
    const chain = await executeInterceptorChain(
      [
        {
          registration: registration(
            'b',
            'mutation',
            ({ payload }) => ({ modified: true, payload: [...(payload as string[]), 'b'] }),
            1
          )
        },
        {
          registration: registration(
            'a',
            'mutation',
            ({ payload }) => ({ modified: true, payload: [...(payload as string[]), 'a'] }),
            1
          )
        },
        {
          registration: registration('shadow', 'mutation', () => ({
            modified: true,
            payload: ['shadow']
          })),
          overrides: { mode: 'audit' }
        },
        {
          registration: registration('warn', 'validation', () => ({
            valid: false,
            severity: 'warn'
          }))
        }
      ],
      'tools/call',
      'request',
      [],
      { request: new Request('http://localhost') },
      'sending'
    )
    expect(chain.payload).toEqual(['a', 'b'])
    expect(chain.audit).toHaveLength(1)
    await expect(
      executeInterceptorChain(
        [
          {
            registration: registration('block', 'validation', () => ({
              valid: false,
              severity: 'error'
            }))
          }
        ],
        'tools/call',
        'request',
        {},
        { request: new Request('http://localhost') }
      )
    ).rejects.toMatchObject({
      code: -32602,
      message: 'Interceptor validation failed',
      data: {
        validationErrors: [
          {
            interceptor: 'block',
            severity: 'error',
            message: 'Validation rejected payload'
          }
        ]
      }
    })
    const completedValidators: string[] = []
    await expect(
      executeInterceptorChain(
        [
          {
            registration: registration('first-validator', 'validation', async () => {
              await Promise.resolve()
              completedValidators.push('first-validator')
              return {
                valid: false,
                severity: 'error',
                messages: [{ severity: 'error', message: 'First rejection' }]
              }
            })
          },
          {
            registration: registration('second-validator', 'validation', () => {
              completedValidators.push('second-validator')
              return {
                valid: false,
                severity: 'error',
                messages: [{ severity: 'error', message: 'Second rejection' }]
              }
            })
          }
        ],
        'tools/call',
        'request',
        {},
        { request: new Request('http://localhost') }
      )
    ).rejects.toMatchObject({
      code: -32602,
      data: {
        validationErrors: [
          {
            interceptor: 'first-validator',
            severity: 'error',
            message: 'First rejection'
          },
          {
            interceptor: 'second-validator',
            severity: 'error',
            message: 'Second rejection'
          }
        ]
      }
    })
    expect(completedValidators.sort()).toEqual(['first-validator', 'second-validator'])

    const observed: unknown[] = []
    const response = await executeInterceptorChain(
      [
        {
          registration: {
            ...registration('response-validator', 'validation', ({ payload }) => {
              observed.push(structuredClone(payload))
              return { valid: true }
            }),
            definition: {
              ...registration('response-validator', 'validation', () => ({ valid: true }))
                .definition,
              hooks: [{ events: ['tools/call'], phase: 'response' }]
            }
          }
        },
        {
          registration: {
            ...registration('response-mutator', 'mutation', ({ payload }) => ({
              modified: true,
              payload: [...(payload as string[]), 'mutated']
            })),
            definition: {
              ...registration('response-mutator', 'mutation', () => ({
                modified: true,
                payload: []
              })).definition,
              hooks: [{ events: ['tools/call'], phase: 'response' }]
            }
          }
        }
      ],
      'tools/call',
      'response',
      ['original'],
      { request: new Request('http://localhost') },
      'receiving'
    )
    expect(observed).toEqual([['original']])
    expect(response.payload).toEqual(['original', 'mutated'])

    const continued = await executeInterceptorChain(
      [
        {
          registration: registration('fails-open', 'mutation', () => {
            throw new Error('unavailable')
          }),
          overrides: { failOpen: true }
        },
        {
          registration: registration('continues', 'mutation', ({ payload }) => ({
            modified: true,
            payload: [...(payload as string[]), 'continued']
          }))
        }
      ],
      'tools/call',
      'request',
      [],
      { request: new Request('http://localhost') }
    )
    expect(continued.payload).toEqual(['continued'])

    const original = { stable: true }
    await expect(
      executeInterceptorChain(
        [
          {
            registration: registration('first', 'mutation', () => ({
              modified: true,
              payload: { stable: false }
            }))
          },
          {
            registration: registration('second', 'mutation', () => {
              throw new Error('closed')
            })
          }
        ],
        'tools/call',
        'request',
        original,
        { request: new Request('http://localhost') }
      )
    ).rejects.toMatchObject({
      code: -32603,
      message: 'Interceptor mutation failed',
      data: { failedInterceptor: 'second', lastValidPayload: { stable: true } }
    })
    expect(original).toEqual({ stable: true })

    const isolated = await executeInterceptorChain(
      [
        {
          registration: registration('mutating-validator', 'validation', ({ payload }) => {
            ;(payload as { safe: boolean }).safe = false
            return { valid: false }
          })
        },
        {
          registration: registration('audit-mutator', 'mutation', ({ payload }) => {
            ;(payload as { safe: boolean }).safe = false
            return { modified: true, payload }
          }),
          overrides: { mode: 'audit' }
        },
        {
          registration: registration('failing-open', 'mutation', ({ payload }) => {
            ;(payload as { safe: boolean }).safe = false
            throw new Error('shadow failure')
          }),
          overrides: { failOpen: true }
        }
      ],
      'tools/call',
      'request',
      { safe: true },
      { request: new Request('http://localhost') },
      'sending'
    )
    expect(isolated.payload).toEqual({ safe: true })
    expect(isolated.audit.map(({ status }) => status)).toEqual(['completed', 'failed'])
    expect(isolated.audit[1]).toMatchObject({ severity: 'warn', interceptor: 'failing-open' })

    const auditTimeout = await executeInterceptorChain(
      [
        {
          registration: registration(
            'audit-timeout',
            'validation',
            async (_invocation, context) => {
              await new Promise<void>((resolve) =>
                context.signal.addEventListener('abort', () => resolve(), { once: true })
              )
              return { valid: true }
            }
          ),
          overrides: { mode: 'audit', timeoutMs: 1, failOpen: false }
        }
      ],
      'tools/call',
      'request',
      {},
      { request: new Request('http://localhost') },
      'receiving'
    )
    expect(auditTimeout.audit[0]).toMatchObject({
      status: 'failed',
      severity: 'error',
      interceptor: 'audit-timeout'
    })

    const abort = new AbortController()
    abort.abort('cancelled')
    await expect(
      invokeInterceptor(
        registration('never', 'validation', () => {
          throw new Error('must not execute')
        }),
        { name: 'never', event: 'tools/call', phase: 'request', payload: {} },
        { request: new Request('http://localhost'), signal: abort.signal }
      )
    ).rejects.toMatchObject({ name: 'AbortError' })

    for (const phase of ['request', 'response'] as const) {
      for (const direction of ['sending', 'receiving'] as const) {
        const order: string[] = []
        const dual = (name: string, type: 'mutation' | 'validation') => {
          const item = registration(name, type, ({ payload }) => {
            order.push(type)
            return type === 'mutation' ? { modified: true, payload } : { valid: true }
          })
          item.definition.hooks = [{ events: ['tools/call'], phase }]
          return item
        }
        await executeInterceptorChain(
          [
            { registration: dual('mutation', 'mutation') },
            { registration: dual('validation', 'validation') }
          ],
          'tools/call',
          phase,
          {},
          { request: new Request('http://localhost') },
          direction
        )
        expect(order).toEqual(
          direction === 'sending' ? ['mutation', 'validation'] : ['validation', 'mutation']
        )
      }
    }
  })

  test('preserves action and trust annotations with absent distinct from false', async () => {
    const app = new Elysia().use(mcp({ allowedRoutes: [] })).mcpTool(
      'annotated',
      () => ({
        content: [{ type: 'text', text: 'ok' }],
        _meta: {
          [MCP_TRUST_ANNOTATIONS_ID]: {
            sensitive: false,
            evidenceRef: {
              type: 'custom.v1',
              digest: 'sha256:abc',
              canonicalization: 'jcs/rfc8785'
            }
          }
        }
      }),
      {
        annotations: {
          [MCP_ACTION_METADATA_ID]: {
            inputMetadata: { destination: 'custom-domain', sensitivity: 'custom-class' },
            outcome: 'consequential',
            requiresReview: true
          }
        }
      }
    )
    const listed = await modernRpc(app, 'tools/list')
    expect(
      listed.body.result.tools[0].annotations[MCP_ACTION_METADATA_ID].inputMetadata.destination
    ).toBe('custom-domain')
    const called = await modernRpc(app, 'tools/call', { name: 'annotated', arguments: {} })
    const trust = called.body.result._meta[MCP_TRUST_ANNOTATIONS_ID]
    expect(trust.sensitive).toBe(false)
    expect('untrusted' in trust).toBe(false)

    const invalid = new Elysia().use(mcp({ allowedRoutes: [] })).mcpTool('invalid', () => ({
      content: [{ type: 'text', text: 'ok' }],
      _meta: {
        [MCP_TRUST_ANNOTATIONS_ID]: {
          evidenceRef: {
            type: 'x'.repeat(4097),
            digest: 'sha256:abc',
            canonicalization: 'jcs/rfc8785'
          }
        }
      }
    }))
    const rejected = await modernRpc(invalid, 'tools/call', { name: 'invalid', arguments: {} })
    expect(rejected.body.error.code).toBe(-32603)
  })

  test('emits tools/list_changed when dynamic action metadata changes', async () => {
    const app = new Elysia()
      .use(
        mcp({
          allowedRoutes: [],
          core: {
            subscriptions: {
              toolsListChanged: true,
              provider: {
                subscribe: () => {
                  const iterator: AsyncIterableIterator<McpServerNotification> = {
                    [Symbol.asyncIterator]() {
                      return this
                    },
                    next: () => new Promise(() => {}),
                    return: async () => ({ done: true, value: undefined })
                  }
                  return iterator
                }
              }
            }
          }
        })
      )
      .mcpTool('dynamic', () => 'ok', {
        annotations: { [MCP_ACTION_METADATA_ID]: { outcome: 'benign' } }
      })
    const response = await modernSubscription(app, { toolsListChanged: true })
    const reader = response.body?.getReader()
    const decoder = new TextDecoder()
    expect(decoder.decode((await reader?.read())?.value)).toContain(
      'notifications/subscriptions/acknowledged'
    )
    app.mcpTool('dynamic', () => 'ok', {
      annotations: { [MCP_ACTION_METADATA_ID]: { outcome: 'consequential' } }
    })
    expect(decoder.decode((await reader?.read())?.value)).toContain(
      'notifications/tools/list_changed'
    )
    await reader?.cancel()
  })

  test('binds legacy variant discovery, selection, identifiers, and sessions', async () => {
    expect(() =>
      mcp({
        allowedRoutes: [],
        extensions: { variants: { variants: [{ id: 'default', description: 'Default' }] } }
      })
    ).toThrow('legacy-only')

    const unsupported = new Elysia().use(mcp({ allowedRoutes: [] }))
    const unsupportedHeader = await legacyRequest(
      unsupported,
      'tools/list',
      {},
      { 'mcp-server-variant': 'unknown' }
    )
    expect(unsupportedHeader.body.error).toMatchObject({
      code: -32602,
      message: 'Server variants not supported'
    })

    const signingKey = '0123456789abcdef0123456789abcdef'
    const app = new Elysia()
      .use(
        mcp({
          allowedRoutes: [],
          transport: {
            protocolVersion: LEGACY_PROTOCOL_VERSION,
            protocolVersions: [LEGACY_PROTOCOL_VERSION],
            enableGetSse: true,
            enableDeleteSession: true
          },
          extensions: {
            variants: {
              discoveryLimit: 2,
              variants: [
                {
                  id: 'full',
                  description: 'Full',
                  status: 'stable',
                  tools: ['shared', 'full-only'],
                  prompts: ['suggest']
                },
                {
                  id: 'compact',
                  description: 'Compact',
                  status: 'stable',
                  tools: ['shared'],
                  prompts: []
                }
              ]
            }
          },
          core: { pagination: { pageSize: 1, signingKey } }
        })
      )
      .mcpTool('shared', () => 'shared')
      .mcpTool('full-only', () => 'full')
      .mcpPrompt('suggest', () => 'suggestion', {
        complete: () => ({ values: ['suggestion'] })
      })
    const initialize = await legacyRequest(app, 'initialize', {
      protocolVersion: LEGACY_PROTOCOL_VERSION,
      clientInfo: { name: 'test', version: '1' },
      capabilities: { extensions: { [MCP_SERVER_VARIANTS_ID]: {} } }
    })
    const sessionId = initialize.response.headers.get('mcp-session-id')
    expect(sessionId).toBeTruthy()
    expect(
      initialize.body.result.capabilities.extensions[MCP_SERVER_VARIANTS_ID].availableVariants.map(
        (variant: any) => variant.id
      )
    ).toEqual(['full', 'compact'])
    expect(initialize.body.result.capabilities.resources.subscribe).toBe(false)
    const compact = await legacyRequest(
      app,
      'tools/list',
      {},
      {
        'mcp-session-id': sessionId as string,
        'mcp-server-variant': 'full'
      },
      { [MCP_SERVER_VARIANT_META_KEY]: 'compact' }
    )
    expect(compact.body.result.tools.map((tool: any) => tool.name)).toEqual(['shared'])
    const missing = await legacyRequest(
      app,
      'tools/call',
      { name: 'full-only', arguments: {} },
      { 'mcp-session-id': sessionId as string },
      { [MCP_SERVER_VARIANT_META_KEY]: 'compact' }
    )
    expect(missing.body.error.data.activeVariant).toBe('compact')
    const deniedCompletion = await legacyRequest(
      app,
      'completion/complete',
      {
        ref: { type: 'ref/prompt', name: 'suggest' },
        argument: { name: 'topic', value: '' }
      },
      { 'mcp-session-id': sessionId as string },
      { [MCP_SERVER_VARIANT_META_KEY]: 'compact' }
    )
    expect(deniedCompletion.body.error).toMatchObject({
      code: -32602,
      data: { activeVariant: 'compact' }
    })
    const invalid = await legacyRequest(
      app,
      'tools/list',
      {},
      { 'mcp-session-id': sessionId as string, 'mcp-server-variant': 'missing' }
    )
    expect(invalid.body.error).toMatchObject({
      code: -32602,
      data: { requestedVariant: 'missing', availableVariants: ['full', 'compact'] }
    })

    const firstPage = await legacyRequest(
      app,
      'tools/list',
      {},
      { 'mcp-session-id': sessionId as string },
      { [MCP_SERVER_VARIANT_META_KEY]: 'full' }
    )
    expect(firstPage.body.result.tools).toHaveLength(1)
    expect(firstPage.body.result.nextCursor).toBeTruthy()
    const secondPage = await legacyRequest(
      app,
      'tools/list',
      { cursor: firstPage.body.result.nextCursor },
      { 'mcp-session-id': sessionId as string },
      { [MCP_SERVER_VARIANT_META_KEY]: 'full' }
    )
    expect(secondPage.body.result.tools).toHaveLength(1)
    const reboundVariant = await legacyRequest(
      app,
      'tools/list',
      { cursor: firstPage.body.result.nextCursor },
      { 'mcp-session-id': sessionId as string },
      { [MCP_SERVER_VARIANT_META_KEY]: 'compact' }
    )
    expect(reboundVariant.body.error.code).toBe(-32602)
    const deleted = await app.handle(
      new Request('http://localhost/mcp', {
        method: 'DELETE',
        headers: { 'mcp-session-id': sessionId as string }
      })
    )
    expect(deleted.status).toBe(202)
  })

  test('keeps variant sessions principal-bound and exposes only ranked visible variants', async () => {
    const legacyTransport = {
      protocolVersion: LEGACY_PROTOCOL_VERSION,
      protocolVersions: [LEGACY_PROTOCOL_VERSION] as (typeof LEGACY_PROTOCOL_VERSION)[]
    }
    for (const invalid of [
      { id: 'bad', description: 'Bad', status: 'unknown' },
      { id: 'bad', description: 'Bad', hints: { model: 1 } },
      { id: 'bad', description: 'Bad', tools: ['same', 'same'] },
      {
        id: 'bad',
        description: 'Bad',
        status: 'deprecated',
        deprecationInfo: { message: 'Migrate', removalDate: 'not-a-date' }
      }
    ]) {
      expect(() =>
        mcp({
          allowedRoutes: [],
          transport: legacyTransport,
          extensions: { variants: { variants: [invalid as any] } }
        })
      ).toThrow(/variant/iu)
    }
    const app = new Elysia().use(
      mcp({
        allowedRoutes: [],
        transport: legacyTransport,
        extensions: {
          auth: {
            resource: 'https://variants.example.test/mcp',
            authorizationServers: ['https://auth.example.test'],
            verifyAccessToken: (token) => ({
              tokenType: 'access_token',
              subject: token,
              issuer: 'https://auth.example.test',
              audience: 'https://variants.example.test/mcp',
              scopes: [],
              expiresAt: Math.floor(Date.now() / 1000) + 60
            })
          },
          variants: {
            discoveryLimit: 1,
            variants: [
              { id: 'stable', description: 'Stable', status: 'stable' },
              { id: 'fallback', description: 'Fallback', status: 'experimental' },
              { id: 'private', description: 'Private', status: 'stable' }
            ],
            visible: (variant, context) =>
              variant.id !== 'private' || context.authorization?.principal.subject === 'alice',
            rank: (variants) => variants.map(({ id }) => id).reverse()
          }
        }
      })
    )
    const initialize = await legacyRequest(
      app,
      'initialize',
      {
        protocolVersion: LEGACY_PROTOCOL_VERSION,
        clientInfo: { name: 'test', version: '1' },
        capabilities: { extensions: { [MCP_SERVER_VARIANTS_ID]: {} } }
      },
      { authorization: 'Bearer bob' }
    )
    const variants =
      initialize.body.result.capabilities.extensions[MCP_SERVER_VARIANTS_ID].availableVariants
    expect(variants.map((variant: any) => variant.id)).toEqual(['stable', 'fallback'])
    const experimental = await legacyRequest(
      app,
      'initialize',
      {
        protocolVersion: LEGACY_PROTOCOL_VERSION,
        clientInfo: { name: 'test', version: '1' },
        capabilities: {
          extensions: {
            [MCP_SERVER_VARIANTS_ID]: { variantHints: { hints: { status: 'experimental' } } }
          }
        }
      },
      { authorization: 'Bearer bob' }
    )
    expect(
      experimental.body.result.capabilities.extensions[
        MCP_SERVER_VARIANTS_ID
      ].availableVariants.map((variant: any) => variant.id)
    ).toEqual(['fallback', 'stable'])
    const sessionId = initialize.response.headers.get('mcp-session-id') as string
    const crossPrincipal = await legacyRequest(
      app,
      'tools/list',
      {},
      { 'mcp-session-id': sessionId, authorization: 'Bearer alice' }
    )
    expect(crossPrincipal.body.error).toMatchObject({
      code: -32602,
      message: 'Unknown MCP session'
    })
  })

  test('isolates reused plugin variant sessions between applications', async () => {
    const pendingIterator = (): AsyncIterableIterator<McpServerNotification> => ({
      [Symbol.asyncIterator]() {
        return this
      },
      next: () => new Promise(() => {}),
      return: async () => ({ done: true, value: undefined })
    })
    const plugin = mcp({
      allowedRoutes: [],
      transport: {
        protocolVersion: LEGACY_PROTOCOL_VERSION,
        protocolVersions: [LEGACY_PROTOCOL_VERSION],
        enableGetSse: true,
        enableDeleteSession: true
      },
      core: {
        subscriptions: {
          resources: true,
          heartbeatMs: 1_000,
          provider: { subscribe: pendingIterator }
        }
      },
      extensions: {
        auth: {
          resource: 'https://variants.example.test/mcp',
          authorizationServers: ['https://auth.example.test'],
          verifyAccessToken: () => ({
            tokenType: 'access_token',
            subject: 'shared-principal',
            issuer: 'https://auth.example.test',
            audience: 'https://variants.example.test/mcp',
            scopes: [],
            expiresAt: Math.floor(Date.now() / 1_000) + 60
          })
        },
        variants: {
          variants: [
            {
              id: 'stable',
              description: 'Stable',
              resources: ['file:///shared']
            }
          ]
        }
      }
    })
    const appA = new Elysia().use(plugin).mcpResource('file:///shared', () => 'app-a')
    const appB = new Elysia().use(plugin).mcpResource('file:///shared', () => 'app-b')
    const authorization = 'Bearer shared-token'
    const initialize = (app: Elysia) =>
      legacyRequest(
        app,
        'initialize',
        {
          protocolVersion: LEGACY_PROTOCOL_VERSION,
          clientInfo: { name: 'test', version: '1' },
          capabilities: { extensions: { [MCP_SERVER_VARIANTS_ID]: {} } }
        },
        { authorization }
      )
    const sessionA = (await initialize(appA)).response.headers.get('mcp-session-id') as string
    const sessionB = (await initialize(appB)).response.headers.get('mcp-session-id') as string
    const headersA = { 'mcp-session-id': sessionA, authorization }
    const headersB = { 'mcp-session-id': sessionB, authorization }

    const subscriptionB = await legacyRequest(
      appB,
      'resources/subscribe',
      { uri: 'file:///shared' },
      headersB
    )
    expect(subscriptionB.body.result.subscriptionId).toBeString()

    for (const [method, params] of [
      ['tools/list', {}],
      ['resources/read', { uri: 'file:///shared' }],
      ['resources/unsubscribe', { subscriptionId: subscriptionB.body.result.subscriptionId }]
    ] as const) {
      const crossed = await legacyRequest(appB, method, params, headersA, {
        [MCP_SERVER_VARIANT_META_KEY]: 'stable'
      })
      expect(crossed.body.error).toMatchObject({ code: -32602, message: 'Unknown MCP session' })
    }

    const crossedStream = await appB.handle(
      new Request('http://localhost/mcp', {
        headers: {
          ...headersA,
          'mcp-protocol-version': LEGACY_PROTOCOL_VERSION
        }
      })
    )
    expect(crossedStream.status).toBe(400)
    const crossedDelete = await appB.handle(
      new Request('http://localhost/mcp', { method: 'DELETE', headers: headersA })
    )
    expect(crossedDelete.status).toBe(400)

    const ownRead = await legacyRequest(appB, 'resources/read', { uri: 'file:///shared' }, headersB)
    expect(ownRead.body.result.contents[0].text).toBe('app-b')
    const ownStream = await appB.handle(
      new Request('http://localhost/mcp', {
        headers: {
          ...headersB,
          'mcp-protocol-version': LEGACY_PROTOCOL_VERSION
        }
      })
    )
    const ownReader = ownStream.body?.getReader()
    expect(new TextDecoder().decode((await ownReader?.read())?.value)).toContain(': connected')
    await ownReader?.cancel()
    const ownUnsubscribe = await legacyRequest(
      appB,
      'resources/unsubscribe',
      { subscriptionId: subscriptionB.body.result.subscriptionId },
      headersB
    )
    expect(ownUnsubscribe.body.result).toEqual({})

    const intactA = await legacyRequest(appA, 'tools/list', {}, headersA)
    expect(intactA.body.result.tools).toEqual([])
    const intactB = await legacyRequest(appB, 'tools/list', {}, headersB)
    expect(intactB.body.result.tools).toEqual([])
  })

  test('streams variant-bound resource updates and permits cleanup after variant removal', async () => {
    let releaseFirst!: () => void
    let releaseSecond!: () => void
    const first = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const second = new Promise<void>((resolve) => {
      releaseSecond = resolve
    })
    async function* notifications(): AsyncGenerator<McpServerNotification> {
      await first
      yield { method: 'notifications/resources/updated', params: { uri: 'file:///item' } }
      await second
      yield { method: 'notifications/resources/updated', params: { uri: 'file:///item' } }
    }
    const variants = [
      {
        id: 'stable',
        description: 'Stable',
        status: 'stable' as const,
        resources: ['file:///item']
      }
    ]
    const app = new Elysia()
      .use(
        mcp({
          allowedRoutes: [],
          transport: {
            protocolVersion: LEGACY_PROTOCOL_VERSION,
            protocolVersions: [LEGACY_PROTOCOL_VERSION],
            enableGetSse: true,
            enableDeleteSession: true
          },
          core: {
            subscriptions: {
              resources: true,
              heartbeatMs: 1000,
              provider: { subscribe: () => notifications() }
            }
          },
          extensions: { variants: { variants } }
        })
      )
      .mcpResource('file:///item', () => 'item')
    const initialize = await legacyRequest(app, 'initialize', {
      protocolVersion: LEGACY_PROTOCOL_VERSION,
      clientInfo: { name: 'test', version: '1' },
      capabilities: { extensions: { [MCP_SERVER_VARIANTS_ID]: {} } }
    })
    expect(initialize.body.result.capabilities.resources.subscribe).toBe(true)
    const sessionId = initialize.response.headers.get('mcp-session-id') as string
    const stream = await app.handle(
      new Request('http://localhost/mcp', {
        headers: { 'mcp-session-id': sessionId, 'mcp-protocol-version': LEGACY_PROTOCOL_VERSION }
      })
    )
    const reader = stream.body?.getReader()
    const decoder = new TextDecoder()
    expect(decoder.decode((await reader?.read())?.value)).toContain(': connected')
    const subscription = await legacyRequest(
      app,
      'resources/subscribe',
      { uri: 'file:///item' },
      { 'mcp-session-id': sessionId }
    )
    const subscriptionId = subscription.body.result.subscriptionId
    releaseFirst()
    const update = decoder.decode((await reader?.read())?.value)
    expect(update).toContain('notifications/resources/updated')
    expect(update).toContain(MCP_SERVER_VARIANT_META_KEY)
    variants.splice(0, 1)
    releaseSecond()
    const removed = decoder.decode((await reader?.read())?.value)
    expect(removed).toContain('notifications/resources/list_changed')
    const unsubscribed = await legacyRequest(
      app,
      'resources/unsubscribe',
      { subscriptionId },
      { 'mcp-session-id': sessionId }
    )
    expect(unsubscribed.body.error).toMatchObject({
      code: -32602,
      message: 'Unknown resource subscription'
    })
    await reader?.cancel()
  })

  test('contains variant subscription setup, iterator, cleanup, and SSE abort failures', async () => {
    let setupFails = true
    let iteratorFails = true
    let cooperativeAbort = false
    const variants = [
      {
        id: 'stable',
        description: 'Stable',
        status: 'stable' as const,
        resources: ['file:///item']
      }
    ]
    const app = new Elysia()
      .use(
        mcp({
          allowedRoutes: [],
          transport: {
            protocolVersion: LEGACY_PROTOCOL_VERSION,
            protocolVersions: [LEGACY_PROTOCOL_VERSION],
            enableGetSse: true,
            enableDeleteSession: true
          },
          core: {
            subscriptions: {
              resources: true,
              heartbeatMs: 1000,
              provider: {
                subscribe: (_filter, context) => {
                  if (setupFails) throw new Error('setup failed')
                  const iterator: AsyncIterableIterator<McpServerNotification> = {
                    [Symbol.asyncIterator]() {
                      return this
                    },
                    next: () =>
                      iteratorFails
                        ? Promise.reject(new Error('iterator failed'))
                        : new Promise((resolve) =>
                            context.signal?.addEventListener(
                              'abort',
                              () => {
                                cooperativeAbort = true
                                resolve({ done: true, value: undefined })
                              },
                              { once: true }
                            )
                          ),
                    return: async () => {
                      throw new Error('cleanup failed')
                    }
                  }
                  return iterator
                }
              }
            }
          },
          extensions: { variants: { variants } }
        })
      )
      .mcpResource('file:///item', () => 'item')
    const initialize = await legacyRequest(app, 'initialize', {
      protocolVersion: LEGACY_PROTOCOL_VERSION,
      clientInfo: { name: 'test', version: '1' },
      capabilities: { extensions: { [MCP_SERVER_VARIANTS_ID]: {} } }
    })
    const sessionId = initialize.response.headers.get('mcp-session-id') as string
    const failedSetup = await legacyRequest(
      app,
      'resources/subscribe',
      { uri: 'file:///item' },
      { 'mcp-session-id': sessionId }
    )
    expect(failedSetup.body.error.code).toBe(-32603)

    const abort = new AbortController()
    const stream = await app.handle(
      new Request('http://localhost/mcp', {
        headers: { 'mcp-session-id': sessionId, 'mcp-protocol-version': LEGACY_PROTOCOL_VERSION },
        signal: abort.signal
      })
    )
    const reader = stream.body?.getReader()
    const decoder = new TextDecoder()
    expect(decoder.decode((await reader?.read())?.value)).toContain(': connected')
    setupFails = false
    const subscribed = await legacyRequest(
      app,
      'resources/subscribe',
      { uri: 'file:///item' },
      { 'mcp-session-id': sessionId }
    )
    expect(subscribed.body.result.subscriptionId).toBeTruthy()
    expect(decoder.decode((await reader?.read())?.value)).toContain(
      'notifications/resources/list_changed'
    )
    iteratorFails = false
    const pending = await legacyRequest(
      app,
      'resources/subscribe',
      { uri: 'file:///item' },
      { 'mcp-session-id': sessionId }
    )
    const stopped = await legacyRequest(
      app,
      'resources/unsubscribe',
      { subscriptionId: pending.body.result.subscriptionId },
      { 'mcp-session-id': sessionId }
    )
    expect(stopped.body.result).toEqual({})
    expect(cooperativeAbort).toBe(true)
    abort.abort()
    expect((await reader?.read())?.done).toBe(true)
    const deleted = await app.handle(
      new Request('http://localhost/mcp', {
        method: 'DELETE',
        headers: { 'mcp-session-id': sessionId, 'mcp-protocol-version': LEGACY_PROTOCOL_VERSION }
      })
    )
    expect(deleted.status).toBe(202)
  })
})

async function legacyRequest(
  app: Elysia,
  method: string,
  params: Record<string, unknown>,
  headers: Record<string, string> = {},
  meta?: Record<string, unknown>
) {
  const response = await app.handle(
    new Request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'mcp-protocol-version': LEGACY_PROTOCOL_VERSION,
        ...headers
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method,
        params: meta ? { ...params, _meta: meta } : params
      })
    })
  )
  return { response, body: (await response.json()) as any }
}

function modernSubscription(
  app: Elysia,
  notifications: Record<string, unknown>
): Promise<Response> {
  return app.handle(
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
        id: 'action-metadata-subscription',
        method: 'subscriptions/listen',
        params: {
          notifications,
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientInfo': { name: 'test', version: '1' },
            'io.modelcontextprotocol/clientCapabilities': {}
          }
        }
      })
    })
  )
}
