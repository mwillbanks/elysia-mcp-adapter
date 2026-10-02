import { describe, expect, it } from 'bun:test'
import {
  createMissingTaskCapabilityError,
  createTaskController,
  type DetailedTask,
  deleteTaskController,
  dispatchTaskRequest,
  getMcpTaskContext,
  getTaskController,
  resolveTasksVersion,
  setTaskController,
  type TaskDurableCreateRequest,
  type TaskExecutionScheduler,
  type TaskInputResponse,
  type TaskInputResponses,
  TaskProtocolError,
  type TaskProvider,
  type TaskProviderContext,
  taskCapabilityErrorCode,
  type WorkingTask
} from '../src/extensions/tasks/index.js'
import latestDraftFixture from './fixtures/tasks-draft-5246bc3.json' with { type: 'json' }

const capabilityMeta = {
  'io.modelcontextprotocol/clientCapabilities': {
    extensions: {
      'io.modelcontextprotocol/tasks': {}
    }
  }
}

interface CompatibleLegacyTaskInputResponse extends TaskInputResponse {
  approved: boolean
}

const compatibleLegacyResponse: CompatibleLegacyTaskInputResponse = { approved: true }

function workingTask(taskId = 'task-1'): WorkingTask {
  return {
    taskId,
    status: 'working',
    createdAt: '2026-07-30T12:00:00.000Z',
    lastUpdatedAt: '2026-07-30T12:00:00.000Z',
    ttlMs: 60_000,
    pollIntervalMs: 1_000
  }
}

function completedTask(taskId = 'task-1'): DetailedTask {
  return {
    ...workingTask(taskId),
    status: 'completed',
    result: { content: [{ type: 'text', text: 'done' }] }
  }
}

class TestTaskProvider implements TaskProvider {
  readonly tasks = new Map<string, DetailedTask>()
  readonly updates: Array<{ taskId: string; responses: TaskInputResponses }> = []
  readonly cancellations: string[] = []
  readonly inputRequestKeys = new Set<string>()
  createRequest?: TaskDurableCreateRequest
  createContext?: Readonly<TaskProviderContext>
  scheduler?: TaskExecutionScheduler
  listenTaskIds?: readonly string[]

  async create(
    request: TaskDurableCreateRequest,
    context: TaskProviderContext,
    scheduler: TaskExecutionScheduler
  ): Promise<DetailedTask> {
    this.createRequest = request
    this.createContext = context
    this.scheduler = scheduler
    const task = completedTask()
    this.tasks.set(task.taskId, task)
    return task
  }

  async get(taskId: string, _context: TaskProviderContext): Promise<DetailedTask | undefined> {
    return this.tasks.get(taskId)
  }

  async update(
    taskId: string,
    inputResponses: TaskInputResponses,
    _context: TaskProviderContext
  ): Promise<boolean> {
    if (!this.tasks.has(taskId)) return false
    this.updates.push({ taskId, responses: inputResponses })
    return true
  }

  async requestInput(
    taskId: string,
    key: string,
    _request: { method: 'elicitation/create' | 'sampling/createMessage' | 'roots/list' },
    _context: TaskProviderContext
  ): Promise<boolean> {
    if (!this.tasks.has(taskId) || this.inputRequestKeys.has(`${taskId}:${key}`)) return false
    this.inputRequestKeys.add(`${taskId}:${key}`)
    return true
  }

  async cancel(taskId: string, _context: TaskProviderContext): Promise<boolean> {
    if (!this.tasks.has(taskId)) return false
    this.cancellations.push(taskId)
    return true
  }

  listen(
    taskIds: readonly string[],
    _listener: (task: DetailedTask) => void | Promise<void>,
    _context: TaskProviderContext
  ): undefined {
    this.listenTaskIds = taskIds
    return undefined
  }
}

describe('tasks extension', () => {
  it('pins current and dated versions to final semantics while retaining the draft', () => {
    expect(resolveTasksVersion()).toBe('2026-07-28')
    expect(resolveTasksVersion('current')).toBe('2026-07-28')
    expect(resolveTasksVersion('2026-07-28')).toBe('2026-07-28')
    expect(resolveTasksVersion('draft')).toBe('draft')
    expect(resolveTasksVersion('draft-5246bc3')).toBe('draft-5246bc3')
    expect(taskCapabilityErrorCode('current')).toBe(-32021)
    expect(taskCapabilityErrorCode('draft')).toBe(-32003)
    expect(taskCapabilityErrorCode('draft-5246bc3')).toBe(-32021)
    expect(() => resolveTasksVersion('2025-11-25' as 'draft')).toThrow('Unsupported tasks')
  })

  it('matches the independently recorded current draft contract', () => {
    expect(latestDraftFixture.version).toBe('draft-5246bc3')
    expect(latestDraftFixture.missingCapabilityError).toBe(-32021)
    expect(resolveTasksVersion('draft-5246bc3')).toBe('draft-5246bc3')
    expect(taskCapabilityErrorCode('draft-5246bc3')).toBe(-32021)
    expect(latestDraftFixture.extension).toBe('io.modelcontextprotocol/tasks')
    expect(createTaskController({ provider: new TestTaskProvider() }).capability()).toEqual({
      extensions: { 'io.modelcontextprotocol/tasks': latestDraftFixture.capability }
    })
  })

  it('creates the version-specific missing capability error', () => {
    const finalError = createMissingTaskCapabilityError()
    const draftError = createMissingTaskCapabilityError('draft')

    expect(finalError).toBeInstanceOf(TaskProtocolError)
    expect(finalError).toMatchObject({
      code: -32021,
      message: 'Missing required client capability',
      data: {
        requiredCapabilities: {
          extensions: { 'io.modelcontextprotocol/tasks': {} }
        }
      }
    })
    expect(draftError.code).toBe(-32003)
  })

  it('requires the provider to make a created task immediately readable', async () => {
    const provider: TaskProvider = {
      async create() {
        return workingTask('missing')
      },
      async get() {
        return undefined
      },
      async update() {
        return true
      },
      async requestInput() {
        return true
      },
      async cancel() {
        return true
      }
    }
    const controller = createTaskController({ provider })

    await expect(
      controller.create(
        {
          mode: 'required',
          execution: {
            method: 'tools/call',
            params: { name: 'job' },
            invoke: async () => ({ content: [] })
          }
        },
        { request: new Request('http://localhost/mcp') }
      )
    ).rejects.toThrow('durability contract')
  })

  it('passes the injected route invocation through to the provider', async () => {
    const provider = new TestTaskProvider()
    const controller = createTaskController({ provider })
    let invoked = false

    const result = await controller.create(
      {
        mode: 'optional',
        execution: {
          method: 'tools/call',
          params: { name: 'route-backed-job' },
          invoke: async () => {
            invoked = true
            return { content: [{ type: 'text', text: 'done' }] }
          }
        }
      },
      { request: new Request('http://localhost/mcp') }
    )

    expect(result).toMatchObject({
      resultType: 'task',
      taskId: 'task-1',
      status: 'completed'
    })
    expect(provider.createContext).toMatchObject({ version: '2026-07-28' })
    expect(provider.createRequest).toMatchObject({
      mode: 'optional',
      execution: { method: 'tools/call', params: { name: 'route-backed-job' } }
    })
    expect(provider.createRequest?.execution.method).toBe('tools/call')
    expect(provider.createRequest).not.toHaveProperty('execution.invoke')
    expect(() => structuredClone(provider.createRequest)).not.toThrow()
    expect(() => structuredClone(provider.createContext)).not.toThrow()
    await provider.scheduler?.invoke()
    expect(invoked).toBe(true)
  })

  it('rejects malformed provider records at create and polling boundaries', async () => {
    const malformed = {
      taskId: 'bad-task',
      status: 'working',
      createdAt: 'not-a-date',
      lastUpdatedAt: new Date().toISOString(),
      ttl: 60_000
    }
    const provider: TaskProvider = {
      async create() {
        return malformed as any
      },
      async get() {
        return malformed as any
      },
      async update() {
        return true
      },
      async requestInput() {
        return true
      },
      async cancel() {
        return true
      }
    }
    const controller = createTaskController({ provider })

    await expect(
      controller.create(
        {
          mode: 'required',
          execution: {
            method: 'tools/call',
            params: { name: 'job' },
            invoke: async () => ({ content: [] })
          }
        },
        { request: new Request('http://localhost/mcp') }
      )
    ).rejects.toThrow('created task.createdAt')
    await expect(
      controller.get('bad-task', { request: new Request('http://localhost/mcp') })
    ).rejects.toThrow('task.createdAt')
  })

  it('rejects provider identity mismatches and malformed input requests', async () => {
    const provider = new TestTaskProvider()
    provider.tasks.set('requested', workingTask('different'))
    provider.tasks.set('input-required', {
      ...workingTask('input-required'),
      status: 'input_required',
      inputRequests: {
        invalid: {
          method: 'roots/list',
          params: {}
        } as never
      }
    })
    const controller = createTaskController({ provider })
    const context = { request: new Request('http://localhost/mcp') }

    await expect(controller.get('requested', context)).rejects.toThrow('identity contract')
    await expect(controller.get('input-required', context)).rejects.toThrow(
      'params is not valid for roots/list'
    )
  })

  it('dispatches get, MRTR update, and cooperative cancellation', async () => {
    const provider = new TestTaskProvider()
    const task = workingTask()
    provider.tasks.set(task.taskId, task)
    const controller = createTaskController({ provider })
    const context = {
      request: new Request('http://localhost/mcp'),
      meta: capabilityMeta
    }

    const get = await dispatchTaskRequest(controller, {
      method: 'tasks/get',
      params: { taskId: task.taskId },
      context
    })
    const update = await dispatchTaskRequest(controller, {
      method: 'tasks/update',
      params: {
        taskId: task.taskId,
        inputResponses: {
          confirmation: { action: 'accept' }
        }
      },
      context
    })
    const cancel = await dispatchTaskRequest(controller, {
      method: 'tasks/cancel',
      params: { taskId: task.taskId },
      context
    })

    expect(get).toMatchObject({ resultType: 'complete', taskId: task.taskId })
    expect(update).toEqual({ resultType: 'complete' })
    expect(cancel).toEqual({ resultType: 'complete' })
    expect(provider.updates).toEqual([
      {
        taskId: task.taskId,
        responses: { confirmation: { action: 'accept' } }
      }
    ])
    expect(provider.cancellations).toEqual([task.taskId])
  })

  it('rejects task methods without per-request capability declaration', async () => {
    const provider = new TestTaskProvider()
    const controller = createTaskController({ provider, version: 'draft' })

    await expect(
      dispatchTaskRequest(controller, {
        method: 'tasks/get',
        params: { taskId: 'task-1' },
        context: { request: new Request('http://localhost/mcp') }
      })
    ).rejects.toMatchObject({ code: -32003 })
  })

  it('rejects malformed parameters and unknown task IDs', async () => {
    const provider = new TestTaskProvider()
    const controller = createTaskController({ provider })
    const context = {
      request: new Request('http://localhost/mcp'),
      meta: capabilityMeta
    }

    await expect(
      dispatchTaskRequest(controller, {
        method: 'tasks/update',
        params: { taskId: 'task-1', inputResponses: [] },
        context
      })
    ).rejects.toMatchObject({ code: -32602 })

    await expect(
      dispatchTaskRequest(controller, {
        method: 'tasks/get',
        params: { taskId: 'unknown' },
        context
      })
    ).rejects.toMatchObject({ code: -32602 })
  })

  it('validates recognized responses and safely preserves special unknown keys', async () => {
    const provider = new TestTaskProvider()
    provider.tasks.set('waiting', {
      ...workingTask('waiting'),
      status: 'input_required',
      inputRequests: {
        confirm: { method: 'elicitation/create', params: { message: 'Continue?' } }
      }
    })
    const controller = createTaskController({ provider })
    const context = { request: new Request('http://localhost/mcp'), meta: capabilityMeta }

    await expect(
      dispatchTaskRequest(controller, {
        method: 'tasks/update',
        params: { taskId: 'waiting', inputResponses: { confirm: { accepted: true } } },
        context
      })
    ).rejects.toThrow('inputResponses.confirm.action')

    const inputResponses = JSON.parse(
      '{"confirm":{"action":"accept"},"__proto__":{"action":"accept"},"constructor":{"action":"accept"}}'
    )
    await dispatchTaskRequest(controller, {
      method: 'tasks/update',
      params: { taskId: 'waiting', inputResponses },
      context
    })
    const stored = provider.updates.at(-1)?.responses
    expect(Object.hasOwn(stored ?? {}, '__proto__')).toBe(true)
    expect(Object.hasOwn(stored ?? {}, 'constructor')).toBe(true)
    expect(Object.getPrototypeOf(stored)).toBe(Object.prototype)
  })

  it('preserves open legacy responses and enforces modern core response contracts', async () => {
    const provider = new TestTaskProvider()
    const context = { request: new Request('http://localhost/mcp'), meta: capabilityMeta }
    provider.tasks.set('legacy', {
      ...workingTask('legacy'),
      status: 'input_required',
      inputRequests: { custom: { method: 'roots/list' } }
    })
    await createTaskController({ provider, version: 'draft' }).update(
      'legacy',
      { custom: compatibleLegacyResponse },
      context
    )

    provider.tasks.set('roots', {
      ...workingTask('roots'),
      status: 'input_required',
      inputRequests: { root: { method: 'roots/list' } }
    })
    const controller = createTaskController({ provider, version: 'draft-5246bc3' })
    await expect(
      controller.update('roots', { root: { roots: [{ uri: 'x y' }] } }, context)
    ).rejects.toThrow('file URI')
    await expect(
      controller.update('roots', { root: { roots: [{ uri: 'https://example.com' }] } }, context)
    ).rejects.toThrow('file URI')

    provider.tasks.set('sampling', {
      ...workingTask('sampling'),
      status: 'input_required',
      inputRequests: { sample: { method: 'sampling/createMessage', params: {} } }
    })
    for (const content of [null, 1, {}, { type: 'text', text: 1 }]) {
      await expect(
        controller.update(
          'sampling',
          { sample: { role: 'assistant', model: 'test', content } },
          context
        )
      ).rejects.toThrow('valid MCP sampling content')
    }
    await controller.update(
      'sampling',
      {
        sample: {
          role: 'assistant',
          model: 'test',
          content: {
            type: 'tool_result',
            toolUseId: 'call-1',
            content: [
              { type: 'text', text: 'done' },
              { type: 'resource_link', uri: 'data:text/plain,ok', name: 'result' }
            ]
          }
        }
      },
      context
    )
  })

  it('associates controllers with request identity without retaining request state', () => {
    const provider = new TestTaskProvider()
    const controller = createTaskController({ provider })
    const request = new Request('http://localhost/mcp')

    setTaskController(request, controller)
    expect(getTaskController(request)).toBe(controller)
    expect(getMcpTaskContext(request)).toBe(controller)
    expect(getTaskController(new Request(request))).toBeUndefined()
    expect(deleteTaskController(request)).toBe(true)
    expect(getTaskController(request)).toBeUndefined()
  })

  it('exposes subscription and complete status notification hooks', () => {
    const provider = new TestTaskProvider()
    const controller = createTaskController({ provider })
    const task = workingTask()

    controller.listen(['task-1'], () => undefined, {
      request: new Request('http://localhost/mcp')
    })

    expect(provider.listenTaskIds).toEqual(['task-1'])
    expect(controller.statusNotification(task)).toEqual({
      method: 'notifications/tasks',
      params: task
    })
  })

  it('rejects subscription notifications outside the requested task set', () => {
    const provider = new TestTaskProvider()
    provider.listen = (_taskIds, listener, _context) => {
      listener(workingTask('unexpected'))
      return undefined
    }
    const controller = createTaskController({ provider })

    expect(() =>
      controller.listen(['requested'], () => undefined, {
        request: new Request('http://localhost/mcp')
      })
    ).toThrow('subscription contract')
  })

  it('records MRTR requests with provider-enforced lifetime-unique keys', async () => {
    const provider = new TestTaskProvider()
    const task = workingTask()
    provider.tasks.set(task.taskId, task)
    const controller = createTaskController({ provider })
    const context = {
      request: new Request('http://localhost/mcp'),
      principalKey: 'tenant:user'
    }

    await controller.requestElicitation(task.taskId, 'name', { message: 'Your name?' }, context)
    await controller.requestSampling(task.taskId, 'summary', { messages: [] }, context)
    await controller.requestRoots(task.taskId, 'roots', context)

    expect(provider.inputRequestKeys).toEqual(
      new Set(['task-1:name', 'task-1:summary', 'task-1:roots'])
    )
    await expect(
      controller.requestElicitation(task.taskId, 'name', { message: 'Again?' }, context)
    ).rejects.toMatchObject({ code: -32602 })
  })
})
