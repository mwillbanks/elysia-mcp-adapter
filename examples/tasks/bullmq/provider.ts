import { Job, Queue, Worker } from 'bullmq'
import Redis from 'ioredis-mock'
import type {
  DetailedTask,
  TaskDurableCreateRequest,
  TaskExecutionScheduler,
  TaskInputRequest,
  TaskInputResponses,
  TaskProvider,
  TaskProviderContext,
  TaskStatusListener,
  TaskSubscription
} from '../../../src/index.js'

type RedisClient = InstanceType<typeof Redis>

interface TaskHash {
  taskId: string
  principalKey: string
  status: DetailedTask['status']
  createdAt: string
  lastUpdatedAt: string
  ttlMs: string
  pollIntervalMs: string
  descriptor: string
  result?: string
  error?: string
}

const terminalStatuses = new Set<DetailedTask['status']>(['completed', 'failed', 'cancelled'])

export interface BullMqTaskProviderOptions {
  connection?: RedisClient
  queueName?: string
}

class MockCompatibleWorker extends Worker<{ taskId: string }, Record<string, unknown>> {
  execute(job: Job<{ taskId: string }>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.callProcessJob(job, `mock-${job.id}`, signal)
  }
}

/**
 * An in-memory Redis example with genuine BullMQ Queue/Worker orchestration.
 * The scheduler map is deliberately ephemeral and is never written to Redis or job data.
 */
export class BullMqTaskProvider implements TaskProvider, AsyncDisposable {
  readonly connection: RedisClient
  readonly queue: Queue<{ taskId: string }>
  readonly worker: MockCompatibleWorker
  readonly schedulers = new Map<string, TaskExecutionScheduler>()
  readonly abortControllers = new Map<string, AbortController>()
  readonly channel: string
  readonly prefix: string

  constructor(options: BullMqTaskProviderOptions = {}) {
    this.connection = options.connection ?? new Redis()
    const queueName = options.queueName ?? `tasks-${crypto.randomUUID()}`
    this.prefix = `elysia:${queueName}`
    this.channel = `${this.prefix}:events`
    const connection = this.connection as never
    this.queue = new Queue(queueName, {
      connection,
      prefix: this.prefix,
      skipVersionCheck: true
    })
    this.worker = new MockCompatibleWorker(queueName, async (job) => this.process(job), {
      connection,
      prefix: this.prefix,
      autorun: false,
      concurrency: 2,
      drainDelay: 0.01,
      skipVersionCheck: true,
      skipStalledCheck: true
    })
  }

  async create(
    request: TaskDurableCreateRequest,
    context: TaskProviderContext,
    scheduler: TaskExecutionScheduler
  ): Promise<DetailedTask> {
    const taskId = crypto.randomUUID()
    const now = new Date().toISOString()
    const hash: TaskHash = {
      taskId,
      principalKey: principal(context),
      status: 'working',
      createdAt: now,
      lastUpdatedAt: now,
      ttlMs: request.ttlMs === undefined || request.ttlMs === null ? '' : String(request.ttlMs),
      pollIntervalMs: String(request.pollIntervalMs ?? 25),
      descriptor: JSON.stringify(request.execution)
    }
    await this.connection.hset(this.key(taskId), hash as unknown as Record<string, string>)
    if (request.ttlMs !== undefined && request.ttlMs !== null) {
      await this.connection.pexpire(this.key(taskId), request.ttlMs)
    }
    this.schedulers.set(taskId, scheduler)
    await this.connection.rpush(this.waitingKey(), taskId)
    await this.publish(taskId)
    queueMicrotask(() => {
      void this.dispatchNext().catch(() => undefined)
    })
    return (await this.get(taskId, context)) as DetailedTask
  }

  async get(taskId: string, context: TaskProviderContext): Promise<DetailedTask | undefined> {
    const hash = (await this.connection.hgetall(this.key(taskId))) as unknown as TaskHash
    if (!hash.taskId || hash.principalKey !== principal(context)) return undefined
    return toTask(hash)
  }

  async update(
    taskId: string,
    _inputResponses: TaskInputResponses,
    context: TaskProviderContext
  ): Promise<boolean> {
    return this.owns(taskId, context)
  }

  async requestInput(
    taskId: string,
    _key: string,
    _request: TaskInputRequest,
    context: TaskProviderContext
  ): Promise<boolean> {
    return this.owns(taskId, context)
  }

  async cancel(taskId: string, context: TaskProviderContext): Promise<boolean> {
    if (!(await this.owns(taskId, context))) return false
    const status = (await this.connection.hget(this.key(taskId), 'status')) as
      | DetailedTask['status']
      | null
    if (status && terminalStatuses.has(status)) return true
    await this.connection.lrem(this.waitingKey(), 0, taskId)
    await this.setStatus(taskId, 'cancelled')
    this.abortControllers.get(taskId)?.abort(new Error('Task cancelled'))
    this.schedulers.delete(taskId)
    return true
  }

  async listen(
    taskIds: readonly string[],
    listener: TaskStatusListener,
    context: TaskProviderContext
  ): Promise<TaskSubscription> {
    const acceptedTaskIds: string[] = []
    for (const taskId of taskIds) {
      if (await this.get(taskId, context)) acceptedTaskIds.push(taskId)
    }
    const accepted = new Set(acceptedTaskIds)
    const subscriber = this.connection.duplicate()
    await subscriber.subscribe(this.channel)
    const onMessage = async (_channel: string, taskId: string) => {
      if (!accepted.has(taskId)) return
      const task = await this.get(taskId, context)
      if (task) await listener(task)
    }
    subscriber.on('message', onMessage)
    let closed = false
    return {
      acceptedTaskIds,
      async close() {
        if (closed) return
        closed = true
        subscriber.off('message', onMessage)
        await subscriber.unsubscribe()
        subscriber.disconnect()
      }
    }
  }

  async [Symbol.asyncDispose](): Promise<void> {
    for (const controller of this.abortControllers.values()) controller.abort()
    await this.worker.close(true)
    await this.queue.close()
    this.connection.disconnect()
  }

  private async process(job: Job<{ taskId: string }>): Promise<Record<string, unknown>> {
    const { taskId } = job.data
    const hash = (await this.connection.hgetall(this.key(taskId))) as unknown as TaskHash
    if (!hash.taskId) throw new Error(`Missing durable task ${taskId}`)
    JSON.parse(hash.descriptor) as Record<string, unknown>
    const scheduler = this.schedulers.get(taskId)
    if (!scheduler) throw new Error(`No ephemeral scheduler is available for ${taskId}`)
    const controller = new AbortController()
    this.abortControllers.set(taskId, controller)
    try {
      const result = await scheduler.invoke(controller.signal)
      const current = await this.connection.hget(this.key(taskId), 'status')
      if (current !== 'cancelled') await this.setStatus(taskId, 'completed', result)
      return result
    } catch (error) {
      const current = await this.connection.hget(this.key(taskId), 'status')
      if (current !== 'cancelled') {
        await this.setStatus(taskId, 'failed', undefined, {
          code: -32603,
          message: error instanceof Error ? error.message : String(error)
        })
      }
      throw error
    } finally {
      this.abortControllers.delete(taskId)
      this.schedulers.delete(taskId)
    }
  }

  private async dispatchNext(): Promise<void> {
    const taskId = await this.connection.lpop(this.waitingKey())
    if (!taskId) return
    const job = new Job(this.queue, 'execute', { taskId }, { jobId: taskId, attempts: 1 }, taskId)
    await this.worker.execute(job)
  }

  private async owns(taskId: string, context: TaskProviderContext): Promise<boolean> {
    return (await this.connection.hget(this.key(taskId), 'principalKey')) === principal(context)
  }

  private async setStatus(
    taskId: string,
    status: DetailedTask['status'],
    result?: Record<string, unknown>,
    error?: Record<string, unknown>
  ): Promise<void> {
    const values: Record<string, string> = {
      status,
      lastUpdatedAt: new Date().toISOString()
    }
    if (result) values.result = JSON.stringify(result)
    if (error) values.error = JSON.stringify(error)
    await this.connection.hset(this.key(taskId), values)
    await this.publish(taskId)
  }

  private publish(taskId: string): Promise<number> {
    return this.connection.publish(this.channel, taskId)
  }

  private key(taskId: string): string {
    return `${this.prefix}:task:${taskId}`
  }

  private waitingKey(): string {
    return `${this.prefix}:mock-wait`
  }
}

function principal(context: TaskProviderContext): string {
  return context.principalKey ?? ''
}

function toTask(hash: TaskHash): DetailedTask {
  const base = {
    taskId: hash.taskId,
    createdAt: hash.createdAt,
    lastUpdatedAt: hash.lastUpdatedAt,
    ttlMs: hash.ttlMs === '' ? null : Number(hash.ttlMs),
    pollIntervalMs: hash.pollIntervalMs === '' ? undefined : Number(hash.pollIntervalMs)
  }
  if (hash.status === 'completed') {
    return { ...base, status: 'completed', result: JSON.parse(hash.result ?? '{}') }
  }
  if (hash.status === 'failed') {
    return {
      ...base,
      status: 'failed',
      error: JSON.parse(hash.error ?? '{"code":-32603,"message":"Unknown worker error"}')
    }
  }
  if (hash.status === 'cancelled') return { ...base, status: 'cancelled' }
  return { ...base, status: 'working' }
}
