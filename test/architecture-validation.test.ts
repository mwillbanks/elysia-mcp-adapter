import { describe, expect, test } from 'bun:test'
import { Elysia } from 'elysia'
import {
  createTaskController,
  type DetailedTask,
  type TaskProvider
} from '../src/extensions/tasks/index.js'
import {
  invokeInterceptor,
  MCP_ACTION_METADATA_ID,
  type McpInterceptorRegistration,
  mcp
} from '../src/index.js'
import { modernRpc, rpc } from './helpers.js'

const server = { name: 'architecture-validation', version: '1.0.0' } as const

describe('response MIME normalization', () => {
  test('classifies mixed-case JSON, image, and audio content types by normalized essence', async () => {
    const app = new Elysia()
      .use(
        mcp({
          server,
          transport: { validateOrigin: false },
          marshal: { binary: 'base64' }
        })
      )
      .get(
        '/mixed-json',
        () =>
          new Response('{"ok":true}', {
            headers: { 'content-type': 'Application/JSON ; charset=utf-8' }
          }),
        { detail: { operationId: 'mixed.json' } }
      )
      .get(
        '/mixed-image',
        () =>
          new Response(new Blob([Uint8Array.of(1, 2, 3)]), {
            headers: { 'content-type': 'IMAGE/PNG ; charset=binary' }
          }),
        { detail: { operationId: 'mixed.image' } }
      )
      .get(
        '/mixed-audio',
        () =>
          new Response(new Blob([Uint8Array.of(4, 5, 6)]), {
            headers: { 'content-type': 'AuDiO/MPEG ; profile=test' }
          }),
        { detail: { operationId: 'mixed.audio' } }
      )

    const json = await rpc(app, 'tools/call', { name: 'mixed.json', arguments: {} })
    expect(json.body.result.structuredContent).toEqual({ ok: true })

    const image = await rpc(app, 'tools/call', { name: 'mixed.image', arguments: {} })
    expect(image.body.result.content[0]).toMatchObject({ type: 'image', mimeType: 'image/png' })

    const audio = await rpc(app, 'tools/call', { name: 'mixed.audio', arguments: {} })
    expect(audio.body.result.content[0]).toMatchObject({ type: 'audio', mimeType: 'audio/mpeg' })
  })
})

describe('interceptor result validation', () => {
  const registration = (result: unknown): McpInterceptorRegistration => ({
    definition: {
      name: 'strict-severity',
      version: '1',
      description: 'Rejects values that only stringify to a severity',
      type: 'validation',
      hooks: [{ events: ['tools/call'], phase: 'request' }]
    },
    handler: () => result as never
  })

  const invoke = (result: unknown) =>
    invokeInterceptor(
      registration(result),
      { name: 'strict-severity', event: 'tools/call', phase: 'request', payload: {} },
      { request: new Request('http://localhost') }
    )

  test('rejects boxed and object severities at result and message boundaries', async () => {
    await expect(invoke({ valid: true, severity: new String('warn') })).rejects.toMatchObject({
      reason: 'Result invalid'
    })
    await expect(
      invoke({
        valid: false,
        messages: [{ message: 'blocked', severity: { toString: () => 'error' } }]
      })
    ).rejects.toMatchObject({ reason: 'Result invalid' })
  })
})

describe('protocol enum validation', () => {
  const samplingParams = {
    messages: [{ role: 'user', content: { type: 'text', text: 'sample' } }],
    maxTokens: 10
  }
  const capabilities = {
    elicitation: { form: {} },
    sampling: { context: {}, tools: {} }
  }

  test('rejects boxed, coercible, and prototype-key MRTR enums while preserving valid values', async () => {
    const app = new Elysia()
      .use(mcp({ server, allowedRoutes: [] }))
      .mcpTool('boxed-context', () =>
        samplingRequest({ ...samplingParams, includeContext: new String('none') })
      )
      .mcpTool('coercible-choice', () =>
        samplingRequest({
          ...samplingParams,
          toolChoice: { mode: { toString: () => 'auto' } }
        })
      )
      .mcpTool('boxed-schema-type', () => elicitationRequest(new String('string')))
      .mcpTool('prototype-method', () => inputRequiredRequest({ method: 'constructor' }))
      .mcpTool('prototype-schema-type', () => elicitationRequest('toString'))
      .mcpTool('valid-enums', () =>
        inputRequiredRequest({
          method: 'sampling/createMessage',
          params: { ...samplingParams, includeContext: 'none', toolChoice: { mode: 'auto' } }
        })
      )

    for (const name of [
      'boxed-context',
      'coercible-choice',
      'boxed-schema-type',
      'prototype-method',
      'prototype-schema-type'
    ]) {
      const response = await modernRpc(app, 'tools/call', {
        name,
        arguments: {},
        _meta: { 'io.modelcontextprotocol/clientCapabilities': capabilities }
      })
      expect(response.body.error.code).toBe(-32603)
    }

    const valid = await modernRpc(app, 'tools/call', {
      name: 'valid-enums',
      arguments: {},
      _meta: { 'io.modelcontextprotocol/clientCapabilities': capabilities }
    })
    expect(valid.body.result.resultType).toBe('input_required')
  })

  test('rejects boxed and coercible task input methods at the provider boundary', async () => {
    for (const method of [new String('roots/list'), { toString: () => 'roots/list' }]) {
      const controller = createTaskController({ provider: taskProvider(method) })
      await expect(
        controller.get('task-enum', { request: new Request('http://localhost/mcp') })
      ).rejects.toThrow('method is invalid')
    }

    const valid = createTaskController({ provider: taskProvider('roots/list') })
    await expect(
      valid.get('task-enum', { request: new Request('http://localhost/mcp') })
    ).resolves.toMatchObject({ status: 'input_required', resultType: 'complete' })
  })

  test('rejects boxed and coercible action outcomes during tool registration discovery', async () => {
    for (const outcome of [new String('benign'), { toString: () => 'benign' }]) {
      const app = new Elysia()
        .use(mcp({ server, allowedRoutes: [], transport: { validateOrigin: false } }))
        .mcpTool('unsafe-outcome', () => 'ok', {
          annotations: { [MCP_ACTION_METADATA_ID]: { outcome } } as never
        })
      const response = await rpc(app, 'tools/list')
      expect(response.body.error.message).toContain('Action metadata outcome is invalid')
    }
  })
})

function inputRequiredRequest(request: Record<string, unknown>) {
  return {
    resultType: 'input_required' as const,
    inputRequests: { request }
  } as never
}

function samplingRequest(params: Record<string, unknown>) {
  return inputRequiredRequest({ method: 'sampling/createMessage', params })
}

function elicitationRequest(type: unknown) {
  return inputRequiredRequest({
    method: 'elicitation/create',
    params: {
      message: 'Choose',
      requestedSchema: { type: 'object', properties: { choice: { type } } }
    }
  })
}

function taskProvider(method: unknown): TaskProvider {
  const task = {
    taskId: 'task-enum',
    status: 'input_required',
    createdAt: '2026-10-08T00:00:00.000Z',
    lastUpdatedAt: '2026-10-08T00:00:00.000Z',
    ttlMs: 60_000,
    inputRequests: { request: { method } }
  } as unknown as DetailedTask
  return {
    create: async () => task,
    get: async () => task,
    update: async () => true,
    requestInput: async () => true,
    cancel: async () => true
  }
}
