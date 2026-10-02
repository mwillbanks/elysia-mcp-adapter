import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import Ajv2020Import from 'ajv/dist/2020.js'
import addFormatsImport from 'ajv-formats'
import { Elysia } from 'elysia'
import {
  DEFAULT_PROTOCOL_VERSION,
  getMcpInvocationContext,
  type McpServerNotification,
  mcp
} from '../src/index.js'
import coreSchema from './fixtures/core-2026-07-28.schema.json' with { type: 'json' }
import { modernRpc } from './helpers.js'

const signingKey = '0123456789abcdef0123456789abcdef'
const elicitationCapabilities = { elicitation: { form: {} } }
const Ajv2020 = (Ajv2020Import as any).default ?? Ajv2020Import
const addFormats = (addFormatsImport as any).default ?? addFormatsImport

describe('modern core MRTR', () => {
  test('preserves typed input-required results and retries with protected state', async () => {
    const app = new Elysia()
      .use(
        mcp({
          allowedRoutes: [],
          core: { continuation: { signingKey } }
        })
      )
      .mcpTool(
        'profile',
        (_input, context) => {
          const response = context.inputResponses?.profile
          if (!response) {
            return {
              resultType: 'input_required' as const,
              inputRequests: {
                profile: {
                  method: 'elicitation/create' as const,
                  params: {
                    mode: 'form',
                    message: 'Profile',
                    requestedSchema: { type: 'object', properties: { name: { type: 'string' } } }
                  }
                }
              },
              requestState: 'profile-state'
            }
          }
          return { state: context.requestState, response }
        },
        {
          inputSchema: {
            type: 'object',
            properties: { tenant: { type: 'string' } },
            additionalProperties: false
          }
        }
      )

    const first = await modernRpc(app, 'tools/call', {
      name: 'profile',
      arguments: { tenant: 'one' },
      _meta: { 'io.modelcontextprotocol/clientCapabilities': elicitationCapabilities }
    })
    expect(first.body.result).toMatchObject({ resultType: 'input_required' })
    expect(first.body.result).not.toHaveProperty('ttlMs')
    expect(first.body.result.requestState).not.toBe('profile-state')

    const retry = await modernRpc(app, 'tools/call', {
      name: 'profile',
      arguments: { tenant: 'one' },
      requestState: first.body.result.requestState,
      inputResponses: {
        profile: { action: 'accept', content: { name: 'Ada' } },
        ignored: { action: 'cancel' }
      },
      _meta: { 'io.modelcontextprotocol/clientCapabilities': elicitationCapabilities }
    })
    expect(retry.body.result.structuredContent).toMatchObject({
      state: 'profile-state',
      response: { action: 'accept' }
    })

    const tampered = await modernRpc(app, 'tools/call', {
      name: 'profile',
      arguments: { tenant: 'one' },
      requestState: `${first.body.result.requestState}x`,
      _meta: { 'io.modelcontextprotocol/clientCapabilities': elicitationCapabilities }
    })
    expect(tampered.body.error.code).toBe(-32602)

    const rebound = await modernRpc(app, 'tools/call', {
      name: 'profile',
      arguments: { tenant: 'two' },
      requestState: first.body.result.requestState,
      _meta: { 'io.modelcontextprotocol/clientCapabilities': elicitationCapabilities }
    })
    expect(rebound.body.error.code).toBe(-32602)
  })

  test('gates input requests by exact client capabilities', async () => {
    const app = new Elysia().use(mcp({ allowedRoutes: [] })).mcpTool('ask', () => ({
      resultType: 'input_required' as const,
      inputRequests: {
        answer: {
          method: 'elicitation/create' as const,
          params: {
            mode: 'form',
            message: 'Answer',
            requestedSchema: { type: 'object', properties: {} }
          }
        }
      }
    }))
    const response = await modernRpc(app, 'tools/call', { name: 'ask', arguments: {} })
    expect(response.status).toBe(400)
    expect(response.body.error).toMatchObject({
      code: -32021,
      data: { requiredCapabilities: { elicitation: { form: {} } } }
    })

    const compatibleEmptyCapability = await modernRpc(app, 'tools/call', {
      name: 'ask',
      arguments: {},
      _meta: { 'io.modelcontextprotocol/clientCapabilities': { elicitation: {} } }
    })
    expect(compatibleEmptyCapability.body.result.resultType).toBe('input_required')

    const urlOnly = await modernRpc(app, 'tools/call', {
      name: 'ask',
      arguments: {},
      _meta: { 'io.modelcontextprotocol/clientCapabilities': { elicitation: { url: {} } } }
    })
    expect(urlOnly.body.error.code).toBe(-32021)
  })

  test('exposes MRTR and progress to route handlers while preserving Elysia lifecycle', async () => {
    let guarded = 0
    let capturedRequest: Request | undefined
    const app = new Elysia()
      .use(
        mcp({
          core: { continuation: { signingKey } },
          marshal: { includeHttpMetadata: true }
        })
      )
      .get(
        '/route-mrtr',
        ({ request, set }) => {
          guarded += 1
          capturedRequest = request
          set.headers['x-route-mapped'] = 'yes'
          const invocation = getMcpInvocationContext(request)
          const answer = invocation?.inputResponses?.answer
          if (!answer) {
            return {
              resultType: 'input_required' as const,
              inputRequests: {
                answer: {
                  method: 'elicitation/create' as const,
                  params: {
                    message: 'Continue?',
                    requestedSchema: { type: 'object', properties: {} }
                  }
                }
              },
              requestState: 'route-state'
            }
          }
          return { answer, state: invocation.requestState }
        },
        { detail: { operationId: 'route.mrtr' } }
      )
      .get(
        '/route-progress',
        ({ request }) => {
          const invocation = getMcpInvocationContext(request)
          invocation?.reportProgress?.(1, { total: 2, message: 'route started' })
          invocation?.reportProgress?.(2, { total: 2, message: 'route finished' })
          return { done: true }
        },
        { detail: { operationId: 'route.progress' } }
      )

    const first = await modernRpc(app, 'tools/call', {
      name: 'route.mrtr',
      arguments: {},
      _meta: { 'io.modelcontextprotocol/clientCapabilities': { elicitation: {} } }
    })
    expect(first.body.result.resultType).toBe('input_required')

    const retry = await modernRpc(app, 'tools/call', {
      name: 'route.mrtr',
      arguments: {},
      requestState: first.body.result.requestState,
      inputResponses: { answer: { action: 'accept', content: {} } },
      _meta: { 'io.modelcontextprotocol/clientCapabilities': { elicitation: {} } }
    })
    expect(retry.body.result.structuredContent).toMatchObject({
      answer: { action: 'accept' },
      state: 'route-state'
    })
    expect(retry.body.result._meta.http.headers['x-route-mapped']).toBe('yes')
    expect(guarded).toBe(2)
    expect(capturedRequest && getMcpInvocationContext(capturedRequest)).toBeUndefined()

    const progress = await requestWithName(app, 'tools/call', 'route.progress', {
      name: 'route.progress',
      arguments: {},
      _meta: { progressToken: 'route-progress' }
    })
    const progressText = await progress.text()
    expect(progressText).toContain('route started')
    expect(progressText).toContain('route finished')
    expect(progressText).toContain('"done":true')
  })

  test('rejects input-required results on the legacy protocol', async () => {
    const app = new Elysia().use(mcp({ allowedRoutes: [] })).mcpTool('modern-only', () => ({
      resultType: 'input_required' as const,
      requestState: 'state'
    }))
    const response = await app.handle(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'mcp-protocol-version': '2025-11-25'
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'modern-only', arguments: {} }
        })
      })
    )
    expect(((await response.json()) as any).error).toMatchObject({
      code: -32603,
      message: 'Input-required results require MCP 2026-07-28'
    })
  })

  test('rejects expired, replayed, and cross-principal continuations', async () => {
    const consumed = new Set<string>()
    const app = new Elysia()
      .use(
        mcp({
          allowedRoutes: [],
          core: {
            pagination: { pageSize: 1, signingKey },
            continuation: {
              signingKey,
              ttlMs: 100,
              singleUse: true,
              provider: {
                consume(id) {
                  if (consumed.has(id)) return false
                  consumed.add(id)
                  return true
                }
              }
            }
          },
          extensions: {
            auth: {
              resource: 'https://api.example.test/mcp',
              authorizationServers: ['https://auth.example.test'],
              verifyAccessToken: async (token) => ({
                tokenType: 'access_token',
                subject: token,
                issuer: 'https://auth.example.test',
                audience: 'https://api.example.test/mcp',
                scopes: [],
                expiresAt: Math.floor(Date.now() / 1000) + 60
              })
            }
          }
        })
      )
      .mcpTool('once', (_input, context) =>
        context.requestState
          ? { restored: context.requestState }
          : { resultType: 'input_required' as const, requestState: 'once' }
      )
      .mcpTool('other', () => 'other')
    const first = await modernRpc(
      app,
      'tools/call',
      { name: 'once', arguments: {} },
      { authorization: 'Bearer alice' }
    )
    expect(first.status).toBe(200)
    expect(first.body.error).toBeUndefined()
    const state = first.body.result.requestState
    const crossPrincipal = await modernRpc(
      app,
      'tools/call',
      { name: 'once', arguments: {}, requestState: state },
      { authorization: 'Bearer bob' }
    )
    expect(crossPrincipal.body.error.code).toBe(-32602)
    const accepted = await modernRpc(
      app,
      'tools/call',
      { name: 'once', arguments: {}, requestState: state },
      { authorization: 'Bearer alice' }
    )
    expect(accepted.body.result.structuredContent).toEqual({ restored: 'once' })
    const replay = await modernRpc(
      app,
      'tools/call',
      { name: 'once', arguments: {}, requestState: state },
      { authorization: 'Bearer alice' }
    )
    expect(replay.body.error.code).toBe(-32602)

    const alicePage = await modernRpc(app, 'tools/list', {}, { authorization: 'Bearer alice' })
    const bobPage = await modernRpc(
      app,
      'tools/list',
      { cursor: alicePage.body.result.nextCursor },
      { authorization: 'Bearer bob' }
    )
    expect(bobPage.body.error.code).toBe(-32602)

    const expiring = new Elysia()
      .use(mcp({ allowedRoutes: [], core: { continuation: { signingKey, ttlMs: 1 } } }))
      .mcpTool('expires', (_input, context) =>
        context.requestState
          ? 'unexpected'
          : { resultType: 'input_required' as const, requestState: 'short' }
      )
    const expiringFirst = await modernRpc(expiring, 'tools/call', {
      name: 'expires',
      arguments: {}
    })
    await Bun.sleep(5)
    const expired = await modernRpc(expiring, 'tools/call', {
      name: 'expires',
      arguments: {},
      requestState: expiringFirst.body.result.requestState
    })
    expect(expired.body.error.code).toBe(-32602)
  })

  test('supports sampling and roots retries while renewing missing inputs', async () => {
    const app = new Elysia()
      .use(mcp({ allowedRoutes: [] }))
      .mcpTool('research', (_input, context) => {
        const sample = context.inputResponses?.sample
        const roots = context.inputResponses?.roots
        const inputRequests: Record<string, any> = {}
        if (!sample) {
          inputRequests.sample = {
            method: 'sampling/createMessage',
            params: {
              messages: [{ role: 'user', content: { type: 'text', text: 'Summarize' } }],
              maxTokens: 100
            }
          }
        }
        if (!roots) inputRequests.roots = { method: 'roots/list' }
        if (Object.keys(inputRequests).length > 0) {
          return { resultType: 'input_required' as const, inputRequests }
        }
        return { sample, roots }
      })
    const capabilities = { sampling: {}, roots: {} }
    const first = await modernRpc(app, 'tools/call', {
      name: 'research',
      arguments: {},
      _meta: { 'io.modelcontextprotocol/clientCapabilities': capabilities }
    })
    expect(Object.keys(first.body.result.inputRequests)).toEqual(['sample', 'roots'])
    const partial = await modernRpc(app, 'tools/call', {
      name: 'research',
      arguments: {},
      inputResponses: {
        sample: {
          role: 'assistant',
          content: { type: 'text', text: 'Summary' },
          model: 'example'
        }
      },
      _meta: { 'io.modelcontextprotocol/clientCapabilities': capabilities }
    })
    expect(Object.keys(partial.body.result.inputRequests)).toEqual(['roots'])
    const complete = await modernRpc(app, 'tools/call', {
      name: 'research',
      arguments: {},
      inputResponses: {
        sample: {
          role: 'assistant',
          content: { type: 'text', text: 'Summary' },
          model: 'example'
        },
        roots: { roots: [{ uri: 'file:///workspace', name: 'Workspace' }] }
      },
      _meta: { 'io.modelcontextprotocol/clientCapabilities': capabilities }
    })
    expect(complete.body.result.structuredContent.roots.roots[0].uri).toBe('file:///workspace')
  })

  test('supports input-required resource and prompt retries', async () => {
    const app = new Elysia()
      .use(mcp({ allowedRoutes: [] }))
      .mcpResource('secure://document', (context) =>
        context.inputResponses?.approval
          ? { contents: [{ uri: context.uri, text: 'approved' }] }
          : {
              resultType: 'input_required' as const,
              inputRequests: {
                approval: {
                  method: 'elicitation/create' as const,
                  params: {
                    message: 'Approve read',
                    requestedSchema: { type: 'object', properties: {} }
                  }
                }
              }
            }
      )
      .mcpPrompt('secure-prompt', (_args, context) =>
        context.inputResponses?.approval
          ? 'approved prompt'
          : {
              resultType: 'input_required' as const,
              inputRequests: {
                approval: {
                  method: 'elicitation/create' as const,
                  params: {
                    message: 'Approve prompt',
                    requestedSchema: { type: 'object', properties: {} }
                  }
                }
              }
            }
      )
    const meta = { 'io.modelcontextprotocol/clientCapabilities': elicitationCapabilities }
    const resourceFirst = await modernRpc(app, 'resources/read', {
      uri: 'secure://document',
      _meta: meta
    })
    expect(resourceFirst.body.result.resultType).toBe('input_required')
    const resourceRetry = await modernRpc(app, 'resources/read', {
      uri: 'secure://document',
      inputResponses: { approval: { action: 'accept', content: {} } },
      _meta: meta
    })
    expect(resourceRetry.body.result.contents[0].text).toBe('approved')
    expect(resourceRetry.body.result).not.toHaveProperty('ttlMs')

    const promptFirst = await modernRpc(app, 'prompts/get', {
      name: 'secure-prompt',
      arguments: {},
      _meta: meta
    })
    expect(promptFirst.body.result.resultType).toBe('input_required')
    const promptRetry = await modernRpc(app, 'prompts/get', {
      name: 'secure-prompt',
      arguments: {},
      inputResponses: { approval: { action: 'accept', content: {} } },
      _meta: meta
    })
    expect(promptRetry.body.result.messages[0].content.text).toBe('approved prompt')
  })

  test('rejects malformed input requests and responses', async () => {
    const app = new Elysia()
      .use(mcp({ allowedRoutes: [] }))
      .mcpTool('malformed-request', () => ({
        resultType: 'input_required' as const,
        inputRequests: {
          sample: {
            method: 'sampling/createMessage' as const,
            params: { messages: [], maxTokens: 'many' } as any
          }
        }
      }))
      .mcpTool('malformed-content', () => ({
        resultType: 'input_required' as const,
        inputRequests: {
          sample: {
            method: 'sampling/createMessage' as const,
            params: {
              messages: [{ role: 'user', content: { type: 'text' } }],
              maxTokens: 10
            } as any
          }
        }
      }))
      .mcpTool(
        'malformed-result-state',
        () =>
          ({
            resultType: 'input_required' as const,
            requestState: 42
          }) as any
      )
      .mcpTool(
        'malformed-result-requests',
        () =>
          ({
            resultType: 'input_required' as const,
            inputRequests: 'roots'
          }) as any
      )
      .mcpTool('malformed-elicitation-empty', () => malformedElicitationRequest({}))
      .mcpTool('malformed-elicitation-array', () => malformedElicitationRequest({ type: 'array' }))
      .mcpTool('malformed-elicitation-default', () =>
        malformedElicitationRequest({ type: 'boolean', default: 'yes' })
      )
      .mcpTool('malformed-elicitation-enum', () =>
        malformedElicitationRequest({ type: 'string', enum: [1] })
      )
      .mcpTool('malformed-elicitation-url-space', () =>
        urlElicitationRequest('https://example.test/a b')
      )
      .mcpTool('malformed-elicitation-url-percent', () =>
        urlElicitationRequest('https://example.test/%not')
      )
      .mcpTool('response', () => 'ok')
      .mcpTool('prototype-response', (_arguments, context) => ({
        hasOwnPrototypeKey: Object.hasOwn(context.inputResponses ?? {}, '__proto__'),
        prototypeUnchanged: Object.getPrototypeOf(context.inputResponses ?? {}) === Object.prototype
      }))
    const malformedRequest = await modernRpc(app, 'tools/call', {
      name: 'malformed-request',
      arguments: {},
      _meta: { 'io.modelcontextprotocol/clientCapabilities': { sampling: {} } }
    })
    expect(malformedRequest.body.error.code).toBe(-32603)
    const malformedContent = await modernRpc(app, 'tools/call', {
      name: 'malformed-content',
      arguments: {},
      _meta: { 'io.modelcontextprotocol/clientCapabilities': { sampling: {} } }
    })
    expect(malformedContent.body.error.code).toBe(-32603)
    const malformedResultState = await modernRpc(app, 'tools/call', {
      name: 'malformed-result-state',
      arguments: {}
    })
    expect(malformedResultState.body.error.code).toBe(-32603)
    const malformedResultRequests = await modernRpc(app, 'tools/call', {
      name: 'malformed-result-requests',
      arguments: {}
    })
    expect(malformedResultRequests.body.error.code).toBe(-32603)
    for (const name of [
      'malformed-elicitation-empty',
      'malformed-elicitation-array',
      'malformed-elicitation-default',
      'malformed-elicitation-enum',
      'malformed-elicitation-url-space',
      'malformed-elicitation-url-percent'
    ]) {
      const malformedElicitation = await modernRpc(app, 'tools/call', {
        name,
        arguments: {},
        _meta: {
          'io.modelcontextprotocol/clientCapabilities': elicitationCapabilities
        }
      })
      expect(malformedElicitation.body.error.code).toBe(-32603)
    }
    const malformedResponse = await modernRpc(app, 'tools/call', {
      name: 'response',
      arguments: {},
      inputResponses: { response: { action: 'unknown' } }
    })
    expect(malformedResponse.body.error.code).toBe(-32602)
    const malformedSamplingResponse = await modernRpc(app, 'tools/call', {
      name: 'response',
      arguments: {},
      inputResponses: {
        sample: { role: 'assistant', model: 'example', content: { type: 'text' } }
      }
    })
    expect(malformedSamplingResponse.body.error.code).toBe(-32602)
    const malformedToolResultResponse = await modernRpc(app, 'tools/call', {
      name: 'response',
      arguments: {},
      inputResponses: {
        sample: {
          role: 'assistant',
          model: 'example',
          content: {
            type: 'tool_result',
            toolUseId: 'call-1',
            content: [{ type: 'bogus' }]
          }
        }
      }
    })
    expect(malformedToolResultResponse.body.error.code).toBe(-32602)
    for (const inputResponses of [
      { roots: { roots: [{ uri: 'file:///a b' }] } },
      { roots: { roots: [{ uri: 'file:///%not' }] } },
      {
        sample: {
          role: 'assistant',
          model: 'example',
          content: { type: 'resource_link', uri: 'https://example.test/a b' }
        }
      },
      {
        sample: {
          role: 'assistant',
          model: 'example',
          content: {
            type: 'resource',
            resource: { uri: 'custom://resource/%not', text: 'invalid' }
          }
        }
      }
    ]) {
      const malformedUriResponse = await modernRpc(app, 'tools/call', {
        name: 'response',
        arguments: {},
        inputResponses
      })
      expect(malformedUriResponse.body.error.code).toBe(-32602)
    }
    const validNonHttpContent = await modernRpc(app, 'tools/call', {
      name: 'response',
      arguments: {},
      inputResponses: {
        sample: {
          role: 'assistant',
          model: 'example',
          content: {
            type: 'tool_result',
            toolUseId: 'call-1',
            content: [
              { type: 'resource_link', uri: 'custom://resource/result' },
              {
                type: 'resource',
                resource: { uri: 'data:text/plain,valid', text: 'valid' }
              }
            ]
          }
        }
      }
    })
    expect(validNonHttpContent.status).toBe(200)
    const prototypeResponse = await modernRpc(app, 'tools/call', {
      name: 'prototype-response',
      arguments: {},
      inputResponses: Object.fromEntries([
        ['__proto__', { action: 'accept', content: { safe: true } }]
      ])
    })
    expect(prototypeResponse.body.result.structuredContent).toEqual({
      hasOwnPrototypeKey: true,
      prototypeUnchanged: true
    })
  })
})

describe('modern core utilities', () => {
  test('selects modern by default and retains explicit legacy-only operation', async () => {
    expect(DEFAULT_PROTOCOL_VERSION).toBe('2026-07-28')
    const modernDefault = new Elysia().use(mcp())
    const missingEnvelope = await modernDefault.handle(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
      })
    )
    expect(missingEnvelope.status).toBe(400)
    expect(((await missingEnvelope.json()) as any).error.code).toBe(-32020)

    const malformedModernEnvelopes = [
      {
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-method': 'tools/list'
        },
        _meta: modernMeta()
      },
      {
        headers: modernHeaders('tools/list'),
        _meta: { 'io.modelcontextprotocol/clientCapabilities': {} }
      },
      {
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-method': 'tools/list'
        },
        _meta: {
          ...modernMeta(),
          'io.modelcontextprotocol/protocolVersion': 20260728
        }
      }
    ]
    for (const envelope of malformedModernEnvelopes) {
      const response = await modernDefault.handle(
        new Request('http://localhost/mcp', {
          method: 'POST',
          headers: envelope.headers,
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/list',
            params: { _meta: envelope._meta }
          })
        })
      )
      expect(response.status).toBe(400)
      expect(((await response.json()) as any).error.code).toBe(-32020)
    }

    const legacyOnly = new Elysia().use(
      mcp({ transport: { protocolVersions: ['2025-11-25'], protocolVersion: '2025-11-25' } })
    )
    const legacy = await legacyOnly.handle(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: {} })
      })
    )
    expect(legacy.status).toBe(200)
    expect(await legacy.json()).toMatchObject({ result: {} })
  })

  test('rejects malformed client identity and known capability shapes', async () => {
    const app = new Elysia().use(mcp())
    const invalidMeta = [
      modernMeta({ 'io.modelcontextprotocol/clientInfo': { name: 'client' } }),
      modernMeta({
        'io.modelcontextprotocol/clientInfo': {
          name: 'client',
          version: '1',
          icons: [{ src: 'not a uri' }]
        }
      }),
      modernMeta({
        'io.modelcontextprotocol/clientInfo': {
          name: 'client',
          version: '1',
          icons: [{ src: 'https://example.test/icon.svg', theme: 'contrast' }]
        }
      }),
      modernMeta({
        'io.modelcontextprotocol/clientInfo': {
          name: 'client',
          version: '1',
          websiteUrl: 'https://example.test/a b'
        }
      }),
      modernMeta({
        'io.modelcontextprotocol/clientInfo': {
          name: 'client',
          version: '1',
          icons: [{ src: 'https://example.test/%not' }]
        }
      }),
      modernMeta({ 'io.modelcontextprotocol/clientCapabilities': { sampling: false } }),
      modernMeta({
        'io.modelcontextprotocol/clientCapabilities': { elicitation: { form: false } }
      }),
      modernMeta({
        'io.modelcontextprotocol/clientCapabilities': { roots: { listChanged: 'yes' } }
      }),
      modernMeta({
        'io.modelcontextprotocol/clientCapabilities': { extensions: { vendor: false } }
      })
    ]
    for (const _meta of invalidMeta) {
      const response = await app.handle(
        new Request('http://localhost/mcp', {
          method: 'POST',
          headers: modernHeaders('tools/list'),
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/list',
            params: { _meta }
          })
        })
      )
      expect(response.status).toBe(400)
      expect(((await response.json()) as any).error.code).toBe(-32020)
    }
    const validNonHttpUris = await app.handle(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: modernHeaders('tools/list'),
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list',
          params: {
            _meta: modernMeta({
              'io.modelcontextprotocol/clientInfo': {
                name: 'client',
                version: '1',
                websiteUrl: 'custom://client/profile',
                icons: [{ src: 'data:image/svg+xml,%3Csvg/%3E' }]
              }
            })
          }
        })
      })
    )
    expect(validNonHttpUris.status).toBe(200)
    const validUnknown = await modernRpc(app, 'tools/list', {
      _meta: {
        'io.modelcontextprotocol/clientCapabilities': {
          'com.example/custom': { enabled: true }
        }
      }
    })
    expect(validUnknown.status).toBe(200)

    const withoutOptionalClientInfo = await app.handle(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: modernHeaders('tools/list'),
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list',
          params: {
            _meta: {
              'io.modelcontextprotocol/protocolVersion': '2026-07-28',
              'io.modelcontextprotocol/clientCapabilities': {}
            }
          }
        })
      })
    )
    expect(withoutOptionalClientInfo.status).toBe(200)
  })

  test('matches independently pinned 2026-07-28 result and error constraints', async () => {
    const ajv = new Ajv2020({ strict: true, allowUnionTypes: true })
    addFormats(ajv)
    ajv.addSchema(coreSchema, 'core-2026-07-28')
    const validateComplete = ajv.getSchema('core-2026-07-28#/$defs/ListToolsResult')
    const validateUnsupported = ajv.getSchema(
      'core-2026-07-28#/$defs/UnsupportedProtocolVersionError'
    )
    const validateJsonRpcError = ajv.getSchema('core-2026-07-28#/$defs/JSONRPCErrorResponse')
    const validateRequestMeta = ajv.getSchema('core-2026-07-28#/$defs/RequestMetaObject')
    const validateInputRequired = ajv.getSchema('core-2026-07-28#/$defs/InputRequiredResult')
    if (
      !validateComplete ||
      !validateUnsupported ||
      !validateJsonRpcError ||
      !validateRequestMeta ||
      !validateInputRequired
    ) {
      throw new Error('Pinned core schema definitions were not registered')
    }
    const fixtureBytes = await Bun.file(
      new URL('./fixtures/core-2026-07-28.schema.json', import.meta.url)
    ).arrayBuffer()
    expect(createHash('sha256').update(Buffer.from(fixtureBytes)).digest('hex')).toBe(
      'ef70b61f99b6d2e5e3b46863822eab08dff6a45bedc7a08914e0e5b133f40203'
    )
    const app = new Elysia().use(mcp())
    const complete = await modernRpc(app, 'tools/list')
    expect(validateComplete(complete.body.result)).toBe(true)
    expect(
      validateRequestMeta({
        'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        'io.modelcontextprotocol/clientCapabilities': {}
      })
    ).toBe(true)
    const unsupportedResponse = await app.handle(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'mcp-protocol-version': '2099-01-01' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
      })
    )
    const unsupportedBody = await unsupportedResponse.json()
    expect(unsupportedBody).not.toHaveProperty('id')
    expect(validateJsonRpcError(unsupportedBody)).toBe(true)
    expect(validateUnsupported(unsupportedBody)).toBe(true)

    const modernErrorCases = [
      {
        body: '{',
        expectedCode: -32700,
        expectedId: undefined
      },
      {
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: null,
          method: 'ping',
          params: { _meta: modernMeta() }
        }),
        expectedCode: -32600,
        expectedId: undefined
      },
      {
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1.5,
          method: 'ping',
          params: { _meta: modernMeta() }
        }),
        expectedCode: -32600,
        expectedId: undefined
      },
      {
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'known-id',
          params: { _meta: modernMeta() }
        }),
        expectedCode: -32600,
        expectedId: 'known-id'
      }
    ]
    for (const errorCase of modernErrorCases) {
      const response = await app.handle(
        new Request('http://localhost/mcp', {
          method: 'POST',
          headers: modernHeaders('ping'),
          body: errorCase.body
        })
      )
      const body = (await response.json()) as Record<string, any>
      expect(response.status).toBe(400)
      expect(body.error.code).toBe(errorCase.expectedCode)
      if (errorCase.expectedId === undefined) expect(body).not.toHaveProperty('id')
      else expect(body.id).toBe(errorCase.expectedId)
      expect(validateJsonRpcError(body)).toBe(true)
    }

    const inputApp = new Elysia().use(mcp({ allowedRoutes: [] })).mcpTool('schema-input', () => ({
      resultType: 'input_required' as const,
      inputRequests: {
        answer: {
          method: 'elicitation/create' as const,
          params: {
            message: 'Answer',
            requestedSchema: { type: 'object', properties: {} }
          }
        }
      }
    }))
    const inputRequired = await modernRpc(inputApp, 'tools/call', {
      name: 'schema-input',
      arguments: {},
      _meta: { 'io.modelcontextprotocol/clientCapabilities': { elicitation: {} } }
    })
    expect(validateInputRequired(inputRequired.body.result)).toBe(true)
  })

  test('paginates with tamper-resistant request-bound cursors', async () => {
    const app = new Elysia().use(
      mcp({ allowedRoutes: [], core: { pagination: { pageSize: 2, signingKey } } })
    )
    app
      .mcpTool('one', () => 'one')
      .mcpTool('two', () => 'two')
      .mcpTool('three', () => 'three')
    const first = await modernRpc(app, 'tools/list')
    expect(first.body.result.tools.map((tool: { name: string }) => tool.name)).toEqual([
      'one',
      'two'
    ])
    const cursor = first.body.result.nextCursor
    const second = await modernRpc(app, 'tools/list', { cursor })
    expect(second.body.result.tools.map((tool: { name: string }) => tool.name)).toEqual(['three'])
    expect(second.body.result.nextCursor).toBeUndefined()
    const tampered = await modernRpc(app, 'tools/list', { cursor: `${cursor}x` })
    expect(tampered.body.error.code).toBe(-32602)
    const rebound = await modernRpc(app, 'resources/list', { cursor })
    expect(rebound.body.error.code).toBe(-32602)
  })

  test('completes prompt and resource-template arguments', async () => {
    const app = new Elysia()
      .use(mcp({ allowedRoutes: [] }))
      .mcpPrompt('greet', () => 'hello', {
        complete: ({ argument }) => ({ values: [`${argument.value}da`] })
      })
      .mcpResource('file:///{path}', () => 'data', {
        complete: ({ argument }) => ({ values: [`${argument.value}.md`], total: 1 })
      })
    const discovery = await modernRpc(app, 'server/discover')
    expect(discovery.body.result.capabilities).toHaveProperty('completions')
    const prompt = await modernRpc(app, 'completion/complete', {
      ref: { type: 'ref/prompt', name: 'greet' },
      argument: { name: 'name', value: 'A' }
    })
    expect(prompt.body.result.completion.values).toEqual(['Ada'])
    const resource = await modernRpc(app, 'completion/complete', {
      ref: { type: 'ref/resource', uri: 'file:///{path}' },
      argument: { name: 'path', value: 'readme' }
    })
    expect(resource.body.result.completion).toEqual({ values: ['readme.md'], total: 1 })

    const missing = await modernRpc(app, 'completion/complete', {
      ref: { type: 'ref/prompt', name: 'missing' },
      argument: { name: 'name', value: '' }
    })
    expect(missing.body.error.code).toBe(-32602)

    const invalid = new Elysia()
      .use(mcp({ allowedRoutes: [] }))
      .mcpPrompt('too-many', () => 'prompt', {
        complete: () => ({ values: Array.from({ length: 101 }, (_, index) => String(index)) })
      })
    const overflow = await modernRpc(invalid, 'completion/complete', {
      ref: { type: 'ref/prompt', name: 'too-many' },
      argument: { name: 'name', value: '' }
    })
    expect(overflow.body.error.code).toBe(-32603)
  })

  test('uses configured cache hints and includes server identity on results', async () => {
    const seen: Array<{ method: string; subject?: string }> = []
    const app = new Elysia().use(
      mcp({
        server: { name: 'cache-server', version: '2.0.0' },
        extensions: {
          auth: {
            resource: 'https://cache.example.test/mcp',
            authorizationServers: ['https://auth.example.test'],
            verifyAccessToken: async (token) => ({
              tokenType: 'access_token',
              subject: token,
              issuer: 'https://auth.example.test',
              audience: 'https://cache.example.test/mcp',
              scopes: [],
              expiresAt: Math.floor(Date.now() / 1000) + 60
            })
          }
        },
        core: {
          cache: {
            default: { ttlMs: 30_000 },
            policy(method, context) {
              seen.push({ method, subject: context.authorization?.principal.subject })
              return { cacheScope: 'private' }
            }
          }
        }
      })
    )
    const listed = await modernRpc(app, 'tools/list', {}, { authorization: 'Bearer alice' })
    const bob = await modernRpc(app, 'tools/list', {}, { authorization: 'Bearer bob' })
    expect(listed.body.result).toMatchObject({ cacheScope: 'private', ttlMs: 30_000 })
    expect(listed.body.result._meta['io.modelcontextprotocol/serverInfo']).toEqual({
      name: 'cache-server',
      version: '2.0.0'
    })
    expect(bob.body.result).toMatchObject({ cacheScope: 'private', ttlMs: 30_000 })
    expect(seen).toEqual([
      { method: 'tools/list', subject: 'alice' },
      { method: 'tools/list', subject: 'bob' }
    ])
  })

  test('streams monotonic progress and propagates stream cancellation', async () => {
    let aborted = false
    const app = new Elysia()
      .use(mcp({ allowedRoutes: [] }))
      .mcpTool('work', async (_input, context) => {
        context.reportProgress?.(1, { total: 2, message: 'started' })
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 25)
          context.signal?.addEventListener(
            'abort',
            () => {
              aborted = true
              clearTimeout(timer)
              resolve()
            },
            { once: true }
          )
        })
        context.reportProgress?.(2, { total: 2 })
        return 'done'
      })
    const completed = await progressRequest(app, 'progress-1')
    expect(completed.headers.get('content-type')).toContain('text/event-stream')
    const completedText = await completed.text()
    expect(completedText).toContain('notifications/progress')
    expect(completedText).toContain('"resultType":"complete"')

    const response = await progressRequest(app, 'cancel-me')
    const reader = response.body?.getReader()
    if (!reader) throw new Error('Expected SSE body')
    await reader.read()
    await reader.cancel()
    await Bun.sleep(0)
    expect(aborted).toBe(true)

    aborted = false
    const incomingAbort = new AbortController()
    const incomingResponse = await progressRequest(app, 'incoming-cancel', incomingAbort.signal)
    const incomingReader = incomingResponse.body?.getReader()
    if (!incomingReader) throw new Error('Expected SSE body')
    await incomingReader.read()
    incomingAbort.abort('HTTP client disconnected')
    await incomingReader.read()
    expect(aborted).toBe(true)

    const invalidToken = await modernRpc(app, 'tools/call', {
      name: 'work',
      arguments: {},
      _meta: { progressToken: 1.5 }
    })
    expect(invalidToken.body.error.code).toBe(-32020)

    const nonMonotonic = new Elysia()
      .use(mcp({ allowedRoutes: [] }))
      .mcpTool('bad-progress', (_input, context) => {
        context.reportProgress?.(1)
        context.reportProgress?.(1)
        return 'unreachable'
      })
    const badProgress = await requestWithName(nonMonotonic, 'tools/call', 'bad-progress', {
      name: 'bad-progress',
      arguments: {},
      _meta: { progressToken: 'bad' }
    })
    expect(await badProgress.text()).toContain('strictly increasing')
  })

  test('acknowledges only configured subscriptions and scopes emitted notifications', async () => {
    async function* notifications(): AsyncGenerator<McpServerNotification> {
      yield { method: 'notifications/tools/list_changed' }
      yield { method: 'notifications/resources/updated', params: { uri: 'file:///a' } }
      yield { method: 'notifications/resources/updated', params: { uri: 'file:///a/child' } }
    }
    const app = new Elysia()
      .use(
        mcp({
          core: {
            subscriptions: {
              provider: { subscribe: () => notifications() },
              toolsListChanged: true,
              resources: true,
              heartbeatMs: 1000
            }
          }
        })
      )
      .mcpResource('file:///a', () => 'a')
    const response = await subscriptionRequest(app, {
      toolsListChanged: true,
      promptsListChanged: true,
      resourceSubscriptions: ['file:///a']
    })
    const text = await response.text()
    expect(text.indexOf('notifications/subscriptions/acknowledged')).toBeLessThan(
      text.indexOf('notifications/tools/list_changed')
    )
    expect(text).toContain('notifications/resources/updated')
    expect(text).toContain('file:///a/child')
    expect(text).not.toContain('promptsListChanged":true')
    expect(text).toContain('notifications/cancelled')
    expect(text.indexOf('notifications/cancelled')).toBeLessThan(
      text.indexOf('"resultType":"complete"')
    )
    expect(text).toContain('"resultType":"complete"')
  })

  test('rejects neighboring, cross-authority, and unauthorized resource updates', async () => {
    for (const updatedUri of ['file:///ab', 'file://other/a/child', 'file:///a/private']) {
      async function* notifications(): AsyncGenerator<McpServerNotification> {
        yield { method: 'notifications/resources/updated', params: { uri: updatedUri } }
      }
      const app = new Elysia()
        .use(
          mcp({
            allowedRoutes: [],
            core: {
              subscriptions: {
                provider: { subscribe: () => notifications() },
                resources: true
              }
            }
          })
        )
        .mcpResource('file:///a', () => 'a')
        .mcpResource('file:///a/private', () => 'private', {
          authorization: { requiredScopes: ['admin'] }
        })
      const response = await subscriptionRequest(app, {
        resourceSubscriptions: ['file:///a']
      })
      const text = await response.text()
      expect(text).not.toContain(`"uri":"${updatedUri}"`)
      expect(text).toContain('notifications/cancelled')
      expect(text).toContain('Subscription provider failed')
    }
  })

  test('closes failed subscription providers with cancellation and completion', async () => {
    const app = new Elysia().use(
      mcp({
        allowedRoutes: [],
        core: {
          subscriptions: {
            toolsListChanged: true,
            provider: {
              subscribe: async function* () {
                yield* [] as McpServerNotification[]
                throw new Error('provider failed')
              }
            }
          }
        }
      })
    )
    const response = await subscriptionRequest(app, { toolsListChanged: true })
    const text = await response.text()
    expect(text).toContain('notifications/subscriptions/acknowledged')
    expect(text).toContain('notifications/cancelled')
    expect(text).toContain('"requestId":"subscription-1"')
    expect(text.indexOf('notifications/cancelled')).toBeLessThan(
      text.indexOf('"resultType":"complete"')
    )
  })

  test('contains iterator cleanup failures after provider errors and client cancellation', async () => {
    for (const mode of ['failure', 'cancel'] as const) {
      let returned = 0
      let providerAborted = false
      const app = new Elysia().use(
        mcp({
          allowedRoutes: [],
          core: {
            subscriptions: {
              toolsListChanged: true,
              provider: {
                subscribe(_filter, context) {
                  context.signal?.addEventListener(
                    'abort',
                    () => {
                      providerAborted = true
                    },
                    { once: true }
                  )
                  let emitted = false
                  const iterator: AsyncIterableIterator<McpServerNotification> = {
                    [Symbol.asyncIterator]() {
                      return this
                    },
                    next: async () => {
                      if (mode === 'cancel') {
                        return new Promise<IteratorResult<McpServerNotification>>(() => {})
                      }
                      if (!emitted) {
                        emitted = true
                        return {
                          done: false,
                          value: { method: 'notifications/prompts/list_changed' }
                        }
                      }
                      return { done: true, value: undefined }
                    },
                    return: async () => {
                      returned += 1
                      throw new Error('cleanup failed')
                    }
                  }
                  return iterator
                }
              }
            }
          }
        })
      )
      const response = await subscriptionRequest(app, { toolsListChanged: true })
      if (mode === 'failure') {
        const text = await response.text()
        expect(text).toContain('Subscription provider failed')
      } else {
        const reader = response.body?.getReader()
        if (!reader) throw new Error('Expected subscription stream')
        await reader.read()
        await reader.cancel()
      }
      await Bun.sleep(0)
      expect(providerAborted).toBe(true)
      expect(returned).toBe(1)
    }
  })

  test('filters unauthorized resources and aborts pending subscription providers', async () => {
    let accepted: readonly string[] = []
    let cleaned = false
    const app = new Elysia()
      .use(
        mcp({
          allowedRoutes: [],
          extensions: {
            auth: {
              resource: 'https://subscriptions.example.test/mcp',
              authorizationServers: ['https://auth.example.test'],
              verifyAccessToken: async (token) => ({
                tokenType: 'access_token',
                subject: token,
                issuer: 'https://auth.example.test',
                audience: 'https://subscriptions.example.test/mcp',
                scopes: ['read'],
                expiresAt: Math.floor(Date.now() / 1000) + 60
              })
            }
          },
          core: {
            subscriptions: {
              resources: true,
              provider: {
                subscribe(filter, context) {
                  accepted = filter.resourceSubscriptions ?? []
                  return (async function* () {
                    try {
                      await new Promise<void>((resolve) => {
                        context.signal?.addEventListener('abort', () => resolve(), { once: true })
                      })
                    } finally {
                      cleaned = true
                    }
                  })()
                }
              }
            }
          }
        })
      )
      .mcpResource('file:///public', () => 'public')
      .mcpResource('file:///secret', () => 'secret', {
        authorization: { requiredScopes: ['admin'] }
      })
    const incomingAbort = new AbortController()
    const response = await subscriptionRequest(
      app,
      { resourceSubscriptions: ['file:///public', 'file:///secret', 'file:///missing'] },
      { authorization: 'Bearer user' },
      incomingAbort.signal
    )
    const reader = response.body?.getReader()
    if (!reader) throw new Error('Expected subscription stream')
    const acknowledgment = new TextDecoder().decode((await reader.read()).value)
    expect(acknowledgment).toContain('file:///public')
    expect(acknowledgment).not.toContain('file:///secret')
    expect(accepted).toEqual(['file:///public'])
    incomingAbort.abort('HTTP client disconnected')
    await Bun.sleep(0)
    expect(cleaned).toBe(true)
    await reader.cancel()
  })
})

function malformedElicitationRequest(schema: Record<string, unknown>) {
  return {
    resultType: 'input_required' as const,
    inputRequests: {
      answer: {
        method: 'elicitation/create' as const,
        params: {
          mode: 'form' as const,
          message: 'Answer',
          requestedSchema: {
            type: 'object' as const,
            properties: { answer: schema as any }
          }
        }
      }
    }
  }
}

function urlElicitationRequest(url: string) {
  return {
    resultType: 'input_required' as const,
    inputRequests: {
      answer: {
        method: 'elicitation/create' as const,
        params: { mode: 'url' as const, message: 'Open', url }
      }
    }
  }
}

async function progressRequest(
  app: Elysia,
  token: string,
  signal?: AbortSignal
): Promise<Response> {
  return app.handle(
    new Request('http://localhost/mcp', {
      method: 'POST',
      headers: modernHeaders('tools/call', 'work'),
      signal,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: token,
        method: 'tools/call',
        params: {
          name: 'work',
          arguments: {},
          _meta: modernMeta({ progressToken: token })
        }
      })
    })
  )
}

async function subscriptionRequest(
  app: Elysia,
  notifications: Record<string, unknown>,
  headers: Record<string, string> = {},
  signal?: AbortSignal
): Promise<Response> {
  return app.handle(
    new Request('http://localhost/mcp', {
      method: 'POST',
      headers: { ...modernHeaders('subscriptions/listen'), ...headers },
      signal,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'subscription-1',
        method: 'subscriptions/listen',
        params: { notifications, _meta: modernMeta() }
      })
    })
  )
}

async function requestWithName(
  app: Elysia,
  method: string,
  name: string,
  params: Record<string, unknown>
): Promise<Response> {
  return app.handle(
    new Request('http://localhost/mcp', {
      method: 'POST',
      headers: modernHeaders(method, name),
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method,
        params: {
          ...params,
          _meta: modernMeta(
            typeof params._meta === 'object' && params._meta
              ? (params._meta as Record<string, unknown>)
              : {}
          )
        }
      })
    })
  )
}

function modernHeaders(method: string, name?: string): Record<string, string> {
  return {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'mcp-protocol-version': '2026-07-28',
    'mcp-method': method,
    ...(name ? { 'mcp-name': name } : {})
  }
}

function modernMeta(additional: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    'io.modelcontextprotocol/protocolVersion': '2026-07-28',
    'io.modelcontextprotocol/clientInfo': { name: 'core-test-client', version: '1.0.0' },
    'io.modelcontextprotocol/clientCapabilities': {},
    ...additional
  }
}
