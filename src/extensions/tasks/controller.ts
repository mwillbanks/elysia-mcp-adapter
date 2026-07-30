import {
  assertTaskCreateRequest,
  assertTaskRecord,
  buildTaskExecutionScheduler,
  toDurableTaskCreateRequest,
  toDurableTaskProviderContext
} from './codec.js'
import { createInvalidTaskParamsError, createMissingTaskCapabilityError } from './errors.js'
import {
  type CancelTaskResult,
  type CreateTaskResult,
  type DetailedTask,
  type GetTaskResult,
  TASKS_EXTENSION_ID,
  type TaskControllerOptions,
  type TaskCreateRequest,
  type TaskInputRequest,
  type TaskInputResponses,
  type TaskProviderContext,
  type TaskRequestContext,
  type TaskStatusListener,
  type TaskSubscription,
  type TasksVersion,
  type UpdateTaskResult
} from './types.js'
import { hasTasksCapability } from './validation.js'
import { resolveTasksVersion } from './version.js'

const requestControllers = new WeakMap<Request, TaskController>()

export class TaskController {
  readonly version: TasksVersion
  readonly provider: TaskControllerOptions['provider']

  constructor(options: TaskControllerOptions) {
    if (!options.provider) throw new TypeError('A durable task provider is required')
    this.provider = options.provider
    this.version = resolveTasksVersion(options.version)
  }

  assertClientCapability(meta: Record<string, unknown> | undefined): void {
    if (!hasTasksCapability(meta)) throw createMissingTaskCapabilityError(this.version)
  }

  async create(request: TaskCreateRequest, context: TaskRequestContext): Promise<CreateTaskResult> {
    assertTaskCreateRequest(request)
    const providerContext = this.context(context)
    const durableRequest = toDurableTaskCreateRequest(request)
    const scheduler = buildTaskExecutionScheduler(request.execution.invoke)
    const created = await this.provider.create(durableRequest, providerContext, scheduler)
    assertTaskRecord(created, 'created task')
    const durable = await this.provider.get(created.taskId, providerContext)

    if (!durable) {
      throw new Error(
        `Task provider violated its durability contract: "${created.taskId}" is not readable`
      )
    }
    assertTaskRecord(durable, 'durable task')
    if (durable.taskId !== created.taskId) {
      throw new Error(
        `Task provider violated its durability contract: "${created.taskId}" resolved to "${durable.taskId}"`
      )
    }

    return { ...created, resultType: 'task' }
  }

  async get(taskId: string, context: TaskRequestContext): Promise<GetTaskResult> {
    const task = await this.provider.get(taskId, this.context(context))
    if (!task) throw createInvalidTaskParamsError(`Unknown task: ${taskId}`)
    assertTaskRecord(task, 'task')
    return { ...task, resultType: 'complete' }
  }

  async update(
    taskId: string,
    inputResponses: TaskInputResponses,
    context: TaskRequestContext
  ): Promise<UpdateTaskResult> {
    const accepted = await this.provider.update(taskId, inputResponses, this.context(context))
    if (accepted === false) throw createInvalidTaskParamsError(`Unknown task: ${taskId}`)
    return { resultType: 'complete' }
  }

  async requestInput(
    taskId: string,
    key: string,
    request: TaskInputRequest,
    context: TaskRequestContext
  ): Promise<void> {
    if (key.length === 0) throw createInvalidTaskParamsError('Task input request key is required')
    const accepted = await this.provider.requestInput(taskId, key, request, this.context(context))
    if (accepted === false) {
      throw createInvalidTaskParamsError(`Unknown task or reused input request key: ${taskId}`)
    }
  }

  requestElicitation(
    taskId: string,
    key: string,
    params: Record<string, unknown>,
    context: TaskRequestContext
  ): Promise<void> {
    return this.requestInput(taskId, key, { method: 'elicitation/create', params }, context)
  }

  requestSampling(
    taskId: string,
    key: string,
    params: Record<string, unknown>,
    context: TaskRequestContext
  ): Promise<void> {
    return this.requestInput(taskId, key, { method: 'sampling/createMessage', params }, context)
  }

  requestRoots(taskId: string, key: string, context: TaskRequestContext): Promise<void> {
    return this.requestInput(taskId, key, { method: 'roots/list' }, context)
  }

  async cancel(taskId: string, context: TaskRequestContext): Promise<CancelTaskResult> {
    const accepted = await this.provider.cancel(taskId, this.context(context))
    if (accepted === false) throw createInvalidTaskParamsError(`Unknown task: ${taskId}`)
    return { resultType: 'complete' }
  }

  listen(
    taskIds: readonly string[],
    listener: TaskStatusListener,
    context: TaskRequestContext
  ): Promise<TaskSubscription | undefined> | TaskSubscription | undefined {
    if (!this.provider.listen) return undefined
    return this.provider.listen(
      taskIds,
      (task) => {
        assertTaskRecord(task, 'task notification')
        return listener(task)
      },
      this.context(context)
    )
  }

  statusNotification(task: DetailedTask): {
    method: 'notifications/tasks'
    params: DetailedTask
  } {
    return { method: 'notifications/tasks', params: task }
  }

  capability(): { extensions: { [TASKS_EXTENSION_ID]: Record<string, never> } } {
    return { extensions: { [TASKS_EXTENSION_ID]: {} } }
  }

  private context(context: TaskRequestContext): TaskProviderContext {
    return toDurableTaskProviderContext({
      version: this.version,
      meta: context.meta,
      principalKey: context.principalKey
    })
  }
}

export function createTaskController(options: TaskControllerOptions): TaskController {
  return new TaskController(options)
}

export function setTaskController(request: Request, controller: TaskController): void {
  requestControllers.set(request, controller)
}

export function getTaskController(request: Request): TaskController | undefined {
  return requestControllers.get(request)
}

export function getMcpTaskContext(request: Request): TaskController | undefined {
  return getTaskController(request)
}

export function deleteTaskController(request: Request): boolean {
  return requestControllers.delete(request)
}
