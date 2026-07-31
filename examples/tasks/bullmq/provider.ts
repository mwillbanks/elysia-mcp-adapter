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
} from '@mwillbanks/elysia-mcp-adapter'
import { Job, Queue, Worker } from 'bullmq'
import Redis from 'ioredis-mock'

type RedisClient = InstanceType<typeof Redis>

interface TaskHash {
  [field: string]: string | undefined
  taskId: string
  principalKey: string
  status: DetailedTask['status']
  createdAt: string
  lastUpdatedAt: string
  ttlMs: string
  pollIntervalMs: string
  descriptor: string
  expiryArmed: string
  result?: string
  error?: string
}

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
  readonly executions = new Map<string, Promise<Record<string, unknown>>>()
  readonly expiryTimers = new Map<string, ReturnType<typeof setTimeout>>()
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
      descriptor: JSON.stringify(request.execution),
      expiryArmed: 'false'
    }
    await this.connection.hset(this.key(taskId), hash as unknown as Record<string, string>)
    if (request.ttlMs === 0) return toTask(hash)
    this.schedulers.set(taskId, scheduler)
    await this.connection.rpush(this.waitingKey(), taskId)
    await this.publish(taskId)
    this.dispatchSoon()
    return toTask(hash)
  }

  async get(taskId: string, context: TaskProviderContext): Promise<DetailedTask | undefined> {
    const hash = (await this.connection.hgetall(this.key(taskId))) as unknown as TaskHash
    if (!hash.taskId) {
      await this.cleanupExpired(taskId)
      return undefined
    }
    if (hash.principalKey !== principal(context)) return undefined
    if (hash.ttlMs !== '' && hash.expiryArmed !== 'true') {
      const ttlMs = Number(hash.ttlMs)
      await this.connection.hset(this.key(taskId), 'expiryArmed', 'true')
      await this.connection.pexpire(this.key(taskId), ttlMs)
      hash.expiryArmed = 'true'
      if (ttlMs === 0) await this.cleanupExpired(taskId)
      else this.armExpiry(taskId, ttlMs)
    }
    return toTask(hash)
  }

  async update(
    taskId: string,
    inputResponses: TaskInputResponses,
    context: TaskProviderContext
  ): Promise<boolean> {
    const entries = Object.entries(inputResponses)
    const arguments_ = [principal(context), new Date().toISOString(), String(entries.length)]
    for (const [key, response] of entries) {
      arguments_.push(inputRequestField(key), inputResponseField(key), JSON.stringify(response))
    }
    const transitioned = await this.evalTransition(updateInputScript, taskId, arguments_)
    if (!transitioned) return false
    await this.publish(taskId)
    return true
  }

  async requestInput(
    taskId: string,
    key: string,
    request: TaskInputRequest,
    context: TaskProviderContext
  ): Promise<boolean> {
    const transitioned = await this.evalTransition(requestInputScript, taskId, [
      principal(context),
      inputRequestField(key),
      JSON.stringify(request),
      new Date().toISOString()
    ])
    if (!transitioned) return false
    await this.connection.lrem(this.waitingKey(), 0, taskId)
    this.abortControllers.get(taskId)?.abort(new Error('Task input required'))
    await this.executions.get(taskId)?.catch(() => undefined)
    this.schedulers.delete(taskId)
    await this.publish(taskId)
    return true
  }

  async cancel(taskId: string, context: TaskProviderContext): Promise<boolean> {
    const transitioned = await this.evalTransition(cancelScript, taskId, [
      principal(context),
      new Date().toISOString()
    ])
    if (transitioned === 0) return false
    if (transitioned === 2) return true
    await this.connection.lrem(this.waitingKey(), 0, taskId)
    this.abortControllers.get(taskId)?.abort(new Error('Task cancelled'))
    this.schedulers.delete(taskId)
    await this.publish(taskId)
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
    for (const timer of this.expiryTimers.values()) clearTimeout(timer)
    for (const controller of this.abortControllers.values()) controller.abort()
    await Promise.allSettled(this.executions.values())
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
      await this.completeExecution(taskId, result)
      return result
    } catch (error) {
      await this.failExecution(taskId, error)
      throw error
    } finally {
      this.abortControllers.delete(taskId)
      const status = await this.connection.hget(this.key(taskId), 'status')
      if (status !== 'input_required') this.schedulers.delete(taskId)
    }
  }

  private async dispatchNext(): Promise<void> {
    const taskId = await this.connection.lpop(this.waitingKey())
    if (!taskId) return
    const job = new Job(this.queue, 'execute', { taskId }, { jobId: taskId, attempts: 1 }, taskId)
    const execution = this.worker.execute(job)
    this.executions.set(taskId, execution)
    try {
      await execution
    } finally {
      if (this.executions.get(taskId) === execution) this.executions.delete(taskId)
    }
  }

  private async completeExecution(taskId: string, result: Record<string, unknown>): Promise<void> {
    const transitioned = await this.evalTransition(finishExecutionScript, taskId, [
      'completed',
      new Date().toISOString(),
      'result',
      JSON.stringify(result)
    ])
    if (transitioned) await this.publish(taskId)
  }

  private async failExecution(taskId: string, error: unknown): Promise<void> {
    const transitioned = await this.evalTransition(finishExecutionScript, taskId, [
      'failed',
      new Date().toISOString(),
      'error',
      JSON.stringify({
        code: -32603,
        message: error instanceof Error ? error.message : String(error)
      })
    ])
    if (transitioned) await this.publish(taskId)
  }

  private dispatchSoon(): void {
    queueMicrotask(() => {
      void this.dispatchNext().catch(() => undefined)
    })
  }

  private armExpiry(taskId: string, ttlMs: number): void {
    const existing = this.expiryTimers.get(taskId)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => {
      void this.cleanupExpired(taskId)
    }, ttlMs)
    this.expiryTimers.set(taskId, timer)
  }

  private async cleanupExpired(taskId: string): Promise<void> {
    const timer = this.expiryTimers.get(taskId)
    if (timer) clearTimeout(timer)
    this.expiryTimers.delete(taskId)
    await this.connection.lrem(this.waitingKey(), 0, taskId)
    this.abortControllers.get(taskId)?.abort(new Error('Task expired'))
    this.abortControllers.delete(taskId)
    this.schedulers.delete(taskId)
    await this.connection.del(this.key(taskId))
  }

  private async evalTransition(
    script: string,
    taskId: string,
    arguments_: readonly string[]
  ): Promise<number> {
    return Number(await this.connection.eval(script, 1, this.key(taskId), ...arguments_))
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
  if (hash.status === 'input_required') {
    return {
      ...base,
      status: 'input_required',
      inputRequests: pendingInputRequests(hash)
    }
  }
  return { ...base, status: 'working' }
}

const inputRequestPrefix = 'input-request:'
const inputResponsePrefix = 'input-response:'

const requestInputScript = `
local owner = redis.call('HGET', KEYS[1], 'principalKey')
if owner ~= ARGV[1] then return 0 end
local status = redis.call('HGET', KEYS[1], 'status')
if status == 'completed' or status == 'failed' or status == 'cancelled' then return 0 end
if redis.call('HSETNX', KEYS[1], ARGV[2], ARGV[3]) == 0 then return 0 end
redis.call('HSET', KEYS[1], 'status', 'input_required', 'lastUpdatedAt', ARGV[4])
return 1
`

const cancelScript = `
local owner = redis.call('HGET', KEYS[1], 'principalKey')
if owner ~= ARGV[1] then return 0 end
local status = redis.call('HGET', KEYS[1], 'status')
if not status then return 0 end
if status == 'completed' or status == 'failed' or status == 'cancelled' then return 2 end
redis.call('HSET', KEYS[1], 'status', 'cancelled', 'lastUpdatedAt', ARGV[2])
return 1
`

const updateInputScript = `
local owner = redis.call('HGET', KEYS[1], 'principalKey')
if owner ~= ARGV[1] then return 0 end
local status = redis.call('HGET', KEYS[1], 'status')
if status == 'completed' or status == 'failed' or status == 'cancelled' then return 0 end
local count = tonumber(ARGV[3])
local argument = 4
for _ = 1, count do
  if redis.call('HEXISTS', KEYS[1], ARGV[argument]) == 0 then return 0 end
  argument = argument + 3
end
argument = 4
for _ = 1, count do
  redis.call('HSET', KEYS[1], ARGV[argument + 1], ARGV[argument + 2])
  argument = argument + 3
end
local fields = redis.call('HKEYS', KEYS[1])
local pending = false
for _, field in ipairs(fields) do
  if string.sub(field, 1, 14) == 'input-request:' then
    local key = string.sub(field, 15)
    if redis.call('HEXISTS', KEYS[1], 'input-response:' .. key) == 0 then
      pending = true
      break
    end
  end
end
local nextStatus = 'working'
if pending then nextStatus = 'input_required' end
redis.call('HSET', KEYS[1], 'status', nextStatus, 'lastUpdatedAt', ARGV[2])
return 1
`

const finishExecutionScript = `
if redis.call('HGET', KEYS[1], 'status') ~= 'working' then return 0 end
redis.call('HSET', KEYS[1], 'status', ARGV[1], 'lastUpdatedAt', ARGV[2], ARGV[3], ARGV[4])
return 1
`

function inputRequestField(key: string): string {
  return `${inputRequestPrefix}${key}`
}

function inputResponseField(key: string): string {
  return `${inputResponsePrefix}${key}`
}

function pendingInputRequests(hash: TaskHash): Record<string, TaskInputRequest> {
  const pending: Record<string, TaskInputRequest> = {}
  for (const [field, value] of Object.entries(hash)) {
    if (!field.startsWith(inputRequestPrefix) || !value) continue
    const key = field.slice(inputRequestPrefix.length)
    if (hash[inputResponseField(key)]) continue
    pending[key] = JSON.parse(value) as TaskInputRequest
  }
  return pending
}
