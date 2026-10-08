import { describe, expect, test } from 'bun:test'
import {
  MCP_ACTION_METADATA_ID,
  MCP_SERVER_CARD_MIME_TYPE,
  MCP_SERVER_VARIANTS_ID,
  MCP_TRUST_ANNOTATIONS_ID
} from '@mwillbanks/elysia-mcp-adapter'
import { legacyRpc, modernRpc } from './client.js'
import {
  annotationApp,
  cardApp,
  interceptorApp,
  resetSubscriptionState,
  runBlockingInterceptorExample,
  runLocalInterceptorExamples,
  variantApp,
  wasSubscriptionClosed
} from './server.js'

describe('experimental extensions', () => {
  test('serves a cacheable server card', async () => {
    const first = await cardApp.handle(new Request('http://localhost/mcp/server-card'))
    expect(first.headers.get('content-type')).toContain(MCP_SERVER_CARD_MIME_TYPE)
    const etag = first.headers.get('etag') as string
    const cached = await cardApp.handle(
      new Request('http://localhost/mcp/server-card', { headers: { 'if-none-match': etag } })
    )
    expect(cached.status).toBe(304)
  })

  test('uses canonical interceptor RPC names and local chain semantics', async () => {
    const listed = await modernRpc(interceptorApp, 'interceptors/list', { event: 'tools/call' })
    expect(listed.body.result.interceptors).toHaveLength(2)
    const invoked = await modernRpc(interceptorApp, 'interceptor/invoke', {
      name: 'trim-name',
      event: 'tools/call',
      phase: 'request',
      payload: { name: ' example ' }
    })
    expect(invoked.body.result.payload.name).toBe('example')
    expect(invoked.body.result).toMatchObject({
      interceptor: 'trim-name',
      type: 'mutation',
      phase: 'request'
    })
    const examples = await runLocalInterceptorExamples()
    expect(examples.audit.payload).toEqual(['ordered'])
    expect(examples.audit.audit).toHaveLength(2)
    expect(examples.audit.audit[1]).toMatchObject({
      interceptor: 'audit-failure',
      status: 'failed',
      severity: 'error'
    })
    expect(examples.sendingObservations).toEqual(['marked', 'isolated'])
    expect(examples.receivingObservations).toEqual(['original', 'isolated'])
    expect(examples.sending.payload).toEqual({ marker: 'added' })
    expect(examples.receiving.payload).toEqual({ marker: 'added' })
    await expect(runBlockingInterceptorExample()).rejects.toThrow('validation failed')
  })

  test('preserves action metadata and trust absence semantics', async () => {
    const listed = await modernRpc(annotationApp, 'tools/list')
    expect(listed.body.result.tools[0].annotations[MCP_ACTION_METADATA_ID].requiresReview).toBe(
      true
    )
    const called = await modernRpc(annotationApp, 'tools/call', {
      name: 'publish-report',
      arguments: {}
    })
    const trust = called.body.result._meta[MCP_TRUST_ANNOTATIONS_ID]
    expect(trust.sensitive).toBe(false)
    expect('untrusted' in trust).toBe(false)
    expect(trust.evidenceRef.ref).toBe('urn:example:evidence:1')
  })

  test('binds variants and subscriptions to an authenticated session', async () => {
    resetSubscriptionState()
    const initialized = await legacyRpc(variantApp, 'initialize', {
      protocolVersion: '2025-11-25',
      clientInfo: { name: 'example', version: '1' },
      capabilities: { extensions: { [MCP_SERVER_VARIANTS_ID]: {} } }
    })
    const sessionId = initialized.response.headers.get('mcp-session-id') as string
    expect(sessionId).toBeTruthy()
    expect(
      initialized.body.result.capabilities.extensions[MCP_SERVER_VARIANTS_ID].availableVariants
    ).toHaveLength(2)

    const firstFullPage = await legacyRpc(variantApp, 'tools/list', {}, sessionId, 'full')
    expect(firstFullPage.body.result.tools).toHaveLength(1)
    expect(firstFullPage.body.result.nextCursor).toBeTruthy()
    const secondFullPage = await legacyRpc(
      variantApp,
      'tools/list',
      { cursor: firstFullPage.body.result.nextCursor },
      sessionId,
      'full'
    )
    expect(secondFullPage.body.result.tools).toHaveLength(1)

    const compact = await legacyRpc(variantApp, 'tools/list', {}, sessionId, 'compact')
    expect(compact.body.result.tools.map((tool: any) => tool.name)).toEqual(['shared'])
    const subscribed = await legacyRpc(
      variantApp,
      'resources/subscribe',
      { uri: 'status://current' },
      sessionId,
      'full'
    )
    const subscriptionId = subscribed.body.result.subscriptionId
    expect(subscriptionId).toBeTruthy()
    const stream = await variantApp.handle(
      new Request('http://localhost/mcp', {
        headers: {
          accept: 'text/event-stream',
          authorization: 'Bearer example-user',
          'mcp-session-id': sessionId
        }
      })
    )
    expect(stream.headers.get('content-type')).toContain('text/event-stream')
    const reader = stream.body?.getReader()
    const connected = new TextDecoder().decode((await reader?.read())?.value)
    expect(connected).toContain('connected')
    await legacyRpc(variantApp, 'resources/unsubscribe', { subscriptionId }, sessionId, 'full')
    await reader?.cancel()
    await Bun.sleep(0)
    expect(wasSubscriptionClosed()).toBe(true)

    const wrongPrincipal = await legacyRpc(
      variantApp,
      'tools/list',
      {},
      sessionId,
      'full',
      'Bearer another-user'
    )
    expect(wrongPrincipal.body.error.code).toBe(-32602)
  })
})
