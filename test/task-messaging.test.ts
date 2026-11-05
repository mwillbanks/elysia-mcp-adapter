import { expect, test } from 'bun:test'
import { Elysia } from 'elysia'
import {
  assertTaskInputResponse,
  createMcpTaskExecutionContext,
  type DetailedTask,
  mcp,
  type McpElicitationFormRequest,
  type TaskProvider,
  type TaskProviderContext
} from '../src/index.js'
import { assertTaskRecord, buildTaskExecutionScheduler } from '../src/extensions/tasks/codec.js'
import { modernRpc } from './helpers.js'

const approval: McpElicitationFormRequest = {
  method: 'elicitation/create',
  params: {
    message: 'Proceed?',
    requestedSchema: {
      type: 'object',
      properties: { approved: { type: 'boolean' } },
      required: ['approved']
    }
  }
}

test('binds worker messages to the durable owner and originating capabilities', async () => {
  const clientCapabilities = { elicitation: { form: {} }, roots: {}, sampling: {} }
  const owner: TaskProviderContext = {
    version: '2026-07-28',
    principalKey: 'tenant-a',
    meta: { 'io.modelcontextprotocol/clientCapabilities': clientCapabilities }
  }
  const calls: unknown[][] = []
  const task = createMcpTaskExecutionContext({
    taskId: 'task-a',
    context: owner,
    provider: {
      async setStatusMessage(...args) {
        calls.push(args)
        return true
      },
      async requestInput(...args) {
        calls.push(args)
        return true
      }
    }
  })
  Object.assign(clientCapabilities.elicitation, { url: {} })

  await task.notify.status('Waiting for approval')
  await task.input.request('approval', approval)
  await task.input.request('roots', { method: 'roots/list', params: {} })
  await task.input.request('draft', {
    method: 'sampling/createMessage',
    params: { messages: [], maxTokens: 10 }
  })
  await expect(
    task.input.request('url', {
      method: 'elicitation/create',
      params: { mode: 'url', message: 'Continue online', url: 'https://example.test/approve' }
    })
  ).rejects.toMatchObject({ code: -32021 })

  const boundOwner = {
    version: '2026-07-28',
    principalKey: 'tenant-a',
    meta: {
      'io.modelcontextprotocol/clientCapabilities': {
        elicitation: { form: {} },
        roots: {},
        sampling: {}
      }
    }
  }
  expect(calls).toEqual([
    ['task-a', 'Waiting for approval', boundOwner],
    ['task-a', 'approval', approval, boundOwner],
    ['task-a', 'roots', { method: 'roots/list' }, boundOwner],
    [
      'task-a',
      'draft',
      { method: 'sampling/createMessage', params: { messages: [], maxTokens: 10 } },
      boundOwner
    ]
  ])
})

test('checks client capabilities before the legacy task controller records input', async () => {
  let recorded = 0
  let task: DetailedTask | undefined
  const provider: TaskProvider = {
    async create(_request, _context, scheduler) {
      const result = await scheduler.invoke()
      task = {
        taskId: 'owned-task',
        status: 'completed',
        result,
        createdAt: '2026-07-28T12:00:00.000Z',
        lastUpdatedAt: '2026-07-28T12:00:00.000Z',
        ttlMs: null
      }
      return task
    },
    get: async () => task,
    update: async () => false,
    cancel: async () => false,
    async requestInput() {
      recorded++
      return true
    }
  }
  const app = new Elysia().use(mcp({ extensions: { tasks: { provider } } })).mcpTool(
    'ask',
    async (_args, context) => {
      if (!context.task) throw new Error('Task controller missing')
      await context.task.requestInput('owned-task', 'approval', approval, {
        request: context.request,
        meta: context.meta
      })
      return 'Requested'
    },
    { taskExecution: 'required' }
  )
  const tasks = { 'io.modelcontextprotocol/tasks': {} }
  const unsupported = await modernRpc(app, 'tools/call', {
    name: 'ask',
    _meta: { 'io.modelcontextprotocol/clientCapabilities': { extensions: tasks } }
  })
  expect(unsupported.body.error.code).toBe(-32021)
  expect(recorded).toBe(0)
  const supported = await modernRpc(app, 'tools/call', {
    name: 'ask',
    _meta: {
      'io.modelcontextprotocol/clientCapabilities': { extensions: tasks, elicitation: { form: {} } }
    }
  })
  expect(supported.body.result.resultType).toBe('task')
  expect(recorded).toBe(1)
})

test('forwards scheduler context and rejects MRTR as a completed task result', async () => {
  const signal = new AbortController().signal
  const task = createMcpTaskExecutionContext({
    taskId: 'task-a',
    context: { version: '2026-07-28' },
    provider: { requestInput: async () => true },
    signal
  })
  const scheduler = buildTaskExecutionScheduler(async (receivedSignal, receivedTask) => {
    expect(receivedSignal).toBe(signal)
    expect(receivedTask).toBe(task)
    return { resultType: 'input_required' }
  })
  await expect(scheduler.invoke(undefined, task)).rejects.toThrow('use the task input API')
  expect(() =>
    assertTaskRecord({
      taskId: 'task-a',
      status: 'completed',
      result: { resultType: 'input_required' },
      createdAt: '2026-07-28T12:00:00.000Z',
      lastUpdatedAt: '2026-07-28T12:00:00.000Z',
      ttlMs: null
    })
  ).toThrow('use the task input API')
})

test('validates submitted form content while preserving decline and draft responses', () => {
  expect(() =>
    assertTaskInputResponse(approval, { action: 'accept', content: { approved: 'yes' } })
  ).toThrow()
  expect(() => assertTaskInputResponse(approval, { action: 'accept' })).toThrow()
  assertTaskInputResponse(approval, { action: 'accept', content: { approved: false } })
  assertTaskInputResponse(approval, { action: 'decline' })
  assertTaskInputResponse(approval, { action: 'cancel' })
  assertTaskInputResponse(approval, { resultType: 'legacy' }, undefined, 'draft')

  const urlRequest = {
    method: 'elicitation/create' as const,
    params: { mode: 'url', message: 'Proceed online', url: 'https://example.test/approve' }
  }
  assertTaskInputResponse(urlRequest, { action: 'accept' })
  expect(() =>
    assertTaskInputResponse(urlRequest, { action: 'accept', content: { approved: true } })
  ).toThrow()
})

test('does not accept content when a persisted task declares a malformed elicitation', () => {
  const answer = { action: 'accept', content: { approved: true } }
  expect(() =>
    assertTaskInputResponse(
      { method: 'elicitation/create', params: { mode: 'form', message: 'Proceed?' } },
      answer
    )
  ).toThrow('requires an elicitation schema')
  expect(() =>
    assertTaskInputResponse(
      { method: 'elicitation/create', params: { mode: 'url', message: 'Proceed?' } },
      answer
    )
  ).toThrow('requires an elicitation URL')
  expect(() =>
    assertTaskInputResponse(
      { method: 'elicitation/create', params: { mode: 'invalid', message: 'Proceed?' } },
      answer
    )
  ).toThrow('invalid elicitation mode')
})

test('runs task preflight before enqueueing and keeps HTTP notifications out of the worker', async () => {
  let preflights = 0
  let started = 0
  let statusMessage: string | undefined
  let task: DetailedTask | undefined
  const provider: TaskProvider = {
    async create(_request, context, scheduler) {
      started += 1
      const execution = createMcpTaskExecutionContext({ taskId: 'task-a', context, provider })
      const result = await scheduler.invoke(undefined, execution)
      task = {
        taskId: 'task-a',
        status: 'completed',
        result,
        statusMessage,
        createdAt: '2026-07-28T12:00:00.000Z',
        lastUpdatedAt: '2026-07-28T12:00:00.000Z',
        ttlMs: null
      }
      return task
    },
    async get() {
      return task
    },
    async setStatusMessage(_taskId, message) {
      statusMessage = message
      return true
    },
    update: async () => true,
    requestInput: async () => true,
    cancel: async () => true
  }
  const app = new Elysia().use(mcp({ extensions: { tasks: { provider } } })).mcpTool(
    'run',
    async (_input, context) => {
      context.notify.progress(1)
      if (!context.taskExecution) throw new Error('Task execution context missing')
      await context.taskExecution.notify.status('Worker finished')
      return 'Done'
    },
    {
      taskExecution: 'required',
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name']
      },
      beforeTask(_args, context) {
        preflights += 1
        if (!context.input.response('approval', approval)) {
          return context.input.require({ approval })
        }
      }
    }
  )
  const clientCapabilities = {
    elicitation: { form: {} },
    extensions: { 'io.modelcontextprotocol/tasks': {} }
  }
  const meta = {
    'io.modelcontextprotocol/protocolVersion': '2026-07-28',
    'io.modelcontextprotocol/clientCapabilities': clientCapabilities
  }
  const invalid = await modernRpc(app, 'tools/call', {
    name: 'run',
    arguments: {},
    _meta: meta
  })
  expect(invalid.body.result.isError).toBe(true)
  expect(preflights).toBe(0)

  const first = await modernRpc(app, 'tools/call', {
    name: 'run',
    arguments: { name: 'valid' },
    _meta: meta
  })
  expect(first.body.result.resultType).toBe('input_required')
  expect(started).toBe(0)

  const retry = await app.handle(
    new Request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2026-07-28',
        'mcp-method': 'tools/call',
        'mcp-name': 'run'
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'run',
          arguments: { name: 'valid' },
          _meta: { ...meta, progressToken: 'retry-progress' },
          inputResponses: { approval: { action: 'accept', content: { approved: true } } }
        }
      })
    })
  )
  const payload = await retry.text()
  expect(retry.headers.get('content-type')).toContain('text/event-stream')
  expect(payload).toContain('"resultType":"task"')
  expect(payload).not.toContain('notifications/progress')
  expect(started).toBe(1)
  expect(task).toMatchObject({ status: 'completed', statusMessage: 'Worker finished' })
})
