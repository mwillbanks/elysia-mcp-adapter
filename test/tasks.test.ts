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
  type TaskInputResponses,
  TaskProtocolError,
  type TaskProvider,
  type TaskProviderContext,
  taskCapabilityErrorCode,
  type WorkingTask
} from '../src/extensions/tasks/index.js'

const capabilityMeta = {
  'io.modelcontextprotocol/clientCapabilities': {
    extensions: {
      'io.modelcontextprotocol/tasks': {}
    }
  }
}

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

  listen(taskIds: readonly string[]): undefined {
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
    expect(taskCapabilityErrorCode('current')).toBe(-32021)
    expect(taskCapabilityErrorCode('draft')).toBe(-32003)
    expect(() => resolveTasksVersion('2025-11-25' as 'draft')).toThrow('Unsupported tasks')
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
          confirmation: { resultType: 'complete', action: 'accept' }
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
        responses: { confirmation: { resultType: 'complete', action: 'accept' } }
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
