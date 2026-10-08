import type {
  DetailedTask,
  TaskDurableCreateRequest,
  TaskExecutionScheduler,
  TaskInputRequest,
  TaskInputResponses,
  TaskProvider,
  TaskProviderContext,
  TaskStatusListener,
  TaskSubscription,
  TaskSubscriptionContext
} from '@mwillbanks/elysia-mcp-adapter'
import { assertTaskInputResponse } from '@mwillbanks/elysia-mcp-adapter'
import { createIORedisClient, Queue, Worker } from 'bullmq'
import { Redis } from 'ioredis'

type RedisClient = Redis

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
  version: TaskProviderContext['version']
  expiryArmed: string
  result?: string
  error?: string
}

export interface BullMqTaskProviderOptions {
  connection?: RedisClient
  redisUrl?: string
  queueName?: string
  startWorker?: boolean
  resolveScheduler?: (
    execution: TaskDurableCreateRequest['execution'],
    context: TaskProviderContext
  ) => TaskExecutionScheduler | undefined | Promise<TaskExecutionScheduler | undefined>
}

/**
 * A Redis-backed BullMQ provider. Invocation callbacks remain ephemeral. A
 * trusted resolver may reconstruct callbacks from persisted descriptors after
 * process restart without serializing code or credentials.
 */
export class BullMqTaskProvider implements TaskProvider, AsyncDisposable {
  readonly connection: RedisClient
  readonly queue: Queue<{ taskId: string }>
  readonly worker?: Worker<{ taskId: string }, Record<string, unknown>>
  readonly schedulers = new Map<string, TaskExecutionScheduler>()
  readonly abortControllers = new Map<string, Set<AbortController>>()
  readonly executions = new Map<string, Set<Promise<Record<string, unknown>>>>()
  readonly expiryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  readonly channel: string
  readonly prefix: string
  readonly resolveScheduler?: BullMqTaskProviderOptions['resolveScheduler']
  private readonly ownsConnection: boolean

  constructor(options: BullMqTaskProviderOptions = {}) {
    this.ownsConnection = options.connection === undefined
    this.connection =
      options.connection ??
      new Redis(options.redisUrl ?? process.env.REDIS_URL ?? 'redis://127.0.0.1:6379', {
        maxRetriesPerRequest: null
      })
    this.resolveScheduler = options.resolveScheduler
    const queueName = options.queueName ?? `tasks-${crypto.randomUUID()}`
    this.prefix = `elysia:${queueName}`
    this.channel = `${this.prefix}:events`
    const connection = createIORedisClient(this.connection)
    this.queue = new Queue(queueName, {
      connection,
      prefix: this.prefix
    })
    if (options.startWorker !== false) {
      this.worker = new Worker(
        queueName,
        async (job, token) => {
          if (!token) throw new Error(`BullMQ did not supply a lock token for ${job.data.taskId}`)
          const execution = this.process(job.data.taskId, token)
          const executions = this.executions.get(job.data.taskId) ?? new Set()
          executions.add(execution)
          this.executions.set(job.data.taskId, executions)
          try {
            return await execution
          } finally {
            executions.delete(execution)
            if (executions.size === 0) this.executions.delete(job.data.taskId)
          }
        },
        { connection, prefix: this.prefix, concurrency: 2 }
      )
    }
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
      version: context.version,
      expiryArmed: 'false'
    }
    await this.connection.hset(this.key(taskId), hash as unknown as Record<string, string>)
    if (request.ttlMs === 0) return toTask(hash)
    this.schedulers.set(taskId, scheduler)
    try {
      await this.queue.add('execute', { taskId }, { jobId: taskId, attempts: 1 })
    } catch (error) {
      this.schedulers.delete(taskId)
      await this.connection.del(this.key(taskId))
      throw error
    }
    await this.publish(taskId)
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
    const hash = (await this.connection.hgetall(this.key(taskId))) as unknown as TaskHash
    if (!hash.taskId || hash.principalKey !== principal(context)) return false
    if (hash.status === 'completed' || hash.status === 'failed' || hash.status === 'cancelled') {
      return true
    }
    const entries = Object.entries(inputResponses).flatMap(([key, response]) => {
      const serializedRequest = hash[inputRequestField(key)]
      if (!serializedRequest || hash[inputResponseField(key)]) return []
      assertTaskInputResponse(
        JSON.parse(serializedRequest) as TaskInputRequest,
        response,
        'task input response',
        context.version
      )
      return [[key, response] as const]
    })
    const arguments_ = [principal(context), new Date().toISOString(), String(entries.length)]
    for (const [key, response] of entries) {
      arguments_.push(inputRequestField(key), inputResponseField(key), JSON.stringify(response))
    }
    const transitioned = await this.evalTransition(updateInputScript, taskId, arguments_)
    if (transitioned === 0) return false
    if (transitioned === 1) await this.publish(taskId)
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
    await this.removeWaitingJob(taskId)
    this.abortExecutions(taskId, new Error('Task input required'))
    await Promise.allSettled(this.executions.get(taskId) ?? [])
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
    await this.removeWaitingJob(taskId)
    this.abortExecutions(taskId, new Error('Task cancelled'))
    this.schedulers.delete(taskId)
    await this.publish(taskId)
    return true
  }

  async listen(
    taskIds: readonly string[],
    listener: TaskStatusListener,
    context: TaskSubscriptionContext
  ): Promise<TaskSubscription> {
    const acceptedTaskIds: string[] = []
    for (const taskId of taskIds) {
      if (await this.get(taskId, context)) acceptedTaskIds.push(taskId)
    }
    const accepted = new Set(acceptedTaskIds)
    const subscriber = this.connection.duplicate()
    let closed = false
    let resolveDone!: () => void
    let rejectDone!: (error: unknown) => void
    const done = new Promise<void>((resolve, reject) => {
      resolveDone = resolve
      rejectDone = reject
    })
    void done.catch(() => undefined)
    const close = async (cause?: unknown): Promise<void> => {
      if (closed) return
      closed = true
      context.signal?.removeEventListener('abort', onAbort)
      subscriber.off('message', onMessage)
      subscriber.off('error', onError)
      let failure = cause
      try {
        await subscriber.unsubscribe()
      } catch (error) {
        failure ??= error
      } finally {
        subscriber.disconnect()
      }
      if (failure !== undefined) {
        rejectDone(failure)
        throw failure
      }
      resolveDone()
    }
    const onAbort = () => void close().catch(() => undefined)
    const onError = (error: unknown) => void close(error).catch(() => undefined)
    const onMessage = (_channel: string, taskId: string) => {
      if (closed || context.signal?.aborted || !accepted.has(taskId)) return
      void (async () => {
        const task = await this.get(taskId, context)
        if (closed || context.signal?.aborted || !task) return
        await listener(task)
      })().catch(onError)
    }
    subscriber.on('error', onError)
    try {
      await subscriber.subscribe(this.channel)
    } catch (error) {
      subscriber.off('error', onError)
      subscriber.disconnect()
      throw error
    }
    subscriber.on('message', onMessage)
    const subscription: TaskSubscription = {
      acceptedTaskIds,
      done,
      close
    }
    context.signal?.addEventListener('abort', onAbort, { once: true })
    if (context.signal?.aborted) await subscription.close()
    return subscription
  }

  async [Symbol.asyncDispose](): Promise<void> {
    for (const timer of this.expiryTimers.values()) clearTimeout(timer)
    for (const controllers of this.abortControllers.values()) {
      for (const controller of controllers) controller.abort()
    }
    await Promise.allSettled([...this.executions.values()].flatMap((value) => [...value]))
    await this.worker?.close(true)
    await this.queue.close()
    if (this.ownsConnection) this.connection.disconnect()
  }

  private async process(taskId: string, executionFence: string): Promise<Record<string, unknown>> {
    const claimed = await this.evalExecutionTransition(claimExecutionScript, taskId, executionFence)
    if (!claimed) return {}
    this.abortExecutions(taskId, new Error('Task execution superseded'))
    const hash = (await this.connection.hgetall(this.key(taskId))) as unknown as TaskHash
    if (!hash.taskId) throw new Error(`Missing durable task ${taskId}`)
    const descriptor = JSON.parse(hash.descriptor) as TaskDurableCreateRequest['execution']
    const providerContext: TaskProviderContext = {
      version: hash.version,
      principalKey: hash.principalKey || undefined
    }
    const controller = new AbortController()
    const controllers = this.abortControllers.get(taskId) ?? new Set()
    controllers.add(controller)
    this.abortControllers.set(taskId, controllers)
    try {
      return await this.invokeClaimedExecution(
        taskId,
        executionFence,
        descriptor,
        providerContext,
        controller.signal
      )
    } catch (error) {
      await this.failExecution(taskId, executionFence, error)
      throw error
    } finally {
      await this.releaseClaimedExecution(taskId, executionFence, controllers, controller)
    }
  }

  private async invokeClaimedExecution(
    taskId: string,
    fence: string,
    descriptor: TaskDurableCreateRequest['execution'],
    context: TaskProviderContext,
    signal: AbortSignal
  ): Promise<Record<string, unknown>> {
    const scheduler =
      this.schedulers.get(taskId) ?? (await this.resolveScheduler?.(descriptor, context))
    if (!scheduler) throw new Error(`No ephemeral scheduler is available for ${taskId}`)
    const mayInvoke = await this.evalExecutionTransition(verifyExecutionScript, taskId, fence)
    if (!mayInvoke || signal.aborted) return {}
    const result = await scheduler.invoke(signal)
    await this.completeExecution(taskId, fence, result)
    return result
  }

  private async releaseClaimedExecution(
    taskId: string,
    fence: string,
    controllers: Set<AbortController>,
    controller: AbortController
  ): Promise<void> {
    controllers.delete(controller)
    if (controllers.size === 0) this.abortControllers.delete(taskId)
    await this.evalTransition(releaseExecutionScript, taskId, [fence])
    const status = await this.connection.hget(this.key(taskId), 'status')
    if (status !== 'input_required') this.schedulers.delete(taskId)
  }

  private async completeExecution(
    taskId: string,
    executionFence: string,
    result: Record<string, unknown>
  ): Promise<void> {
    const transitioned = await this.evalExecutionTransition(
      finishExecutionScript,
      taskId,
      executionFence,
      ['completed', new Date().toISOString(), 'result', JSON.stringify(result)]
    )
    if (transitioned) await this.publish(taskId)
  }

  private async failExecution(
    taskId: string,
    executionFence: string,
    error: unknown
  ): Promise<void> {
    const transitioned = await this.evalExecutionTransition(
      finishExecutionScript,
      taskId,
      executionFence,
      ['failed', new Date().toISOString(), 'error', JSON.stringify(taskFailurePayload(error))]
    )
    if (transitioned) await this.publish(taskId)
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
    await this.removeWaitingJob(taskId)
    this.abortExecutions(taskId, new Error('Task expired'))
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

  private async evalExecutionTransition(
    script: string,
    taskId: string,
    executionFence: string,
    arguments_: readonly string[] = []
  ): Promise<number> {
    return Number(
      await this.connection.eval(
        script,
        2,
        this.key(taskId),
        `${this.queue.toKey(taskId)}:lock`,
        executionFence,
        ...arguments_
      )
    )
  }

  private abortExecutions(taskId: string, reason: Error): void {
    for (const controller of this.abortControllers.get(taskId) ?? []) controller.abort(reason)
  }

  private publish(taskId: string): Promise<number> {
    return this.connection.publish(this.channel, taskId)
  }

  private key(taskId: string): string {
    return `${this.prefix}:task:${taskId}`
  }

  private async removeWaitingJob(taskId: string): Promise<void> {
    const job = await this.queue.getJob(taskId)
    if (job) await job.remove().catch(() => undefined)
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
redis.call('HDEL', KEYS[1], 'executionClaim')
return 1
`

const cancelScript = `
local owner = redis.call('HGET', KEYS[1], 'principalKey')
if owner ~= ARGV[1] then return 0 end
local status = redis.call('HGET', KEYS[1], 'status')
if not status then return 0 end
if status == 'completed' or status == 'failed' or status == 'cancelled' then return 2 end
redis.call('HSET', KEYS[1], 'status', 'cancelled', 'lastUpdatedAt', ARGV[2])
redis.call('HDEL', KEYS[1], 'executionClaim')
return 1
`

const updateInputScript = `
local owner = redis.call('HGET', KEYS[1], 'principalKey')
if owner ~= ARGV[1] then return 0 end
local status = redis.call('HGET', KEYS[1], 'status')
if status == 'completed' or status == 'failed' or status == 'cancelled' then return 2 end
local count = tonumber(ARGV[3])
local argument = 4
local accepted = 0
for _ = 1, count do
  if redis.call('HEXISTS', KEYS[1], ARGV[argument]) == 1 and
     redis.call('HEXISTS', KEYS[1], ARGV[argument + 1]) == 0 then
    redis.call('HSET', KEYS[1], ARGV[argument + 1], ARGV[argument + 2])
    accepted = accepted + 1
  end
  argument = argument + 3
end
if accepted == 0 then return 2 end
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
redis.call('HDEL', KEYS[1], 'executionClaim')
return 1
`

const finishExecutionScript = `
if redis.call('HGET', KEYS[1], 'status') ~= 'working' then return 0 end
if redis.call('GET', KEYS[2]) ~= ARGV[1] then return 0 end
if redis.call('HGET', KEYS[1], 'executionClaim') ~= ARGV[1] then return 0 end
redis.call('HSET', KEYS[1], 'status', ARGV[2], 'lastUpdatedAt', ARGV[3], ARGV[4], ARGV[5])
redis.call('HDEL', KEYS[1], 'executionClaim')
return 1
`

const claimExecutionScript = `
if redis.call('GET', KEYS[2]) ~= ARGV[1] then return 0 end
if redis.call('HGET', KEYS[1], 'status') ~= 'working' then return 0 end
local claim = redis.call('HGET', KEYS[1], 'executionClaim')
if claim == ARGV[1] then return 0 end
redis.call('HSET', KEYS[1], 'executionClaim', ARGV[1])
return 1
`

const verifyExecutionScript = `
if redis.call('GET', KEYS[2]) ~= ARGV[1] then return 0 end
if redis.call('HGET', KEYS[1], 'status') ~= 'working' then return 0 end
if redis.call('HGET', KEYS[1], 'executionClaim') ~= ARGV[1] then return 0 end
return 1
`

const releaseExecutionScript = `
if redis.call('HGET', KEYS[1], 'executionClaim') ~= ARGV[1] then return 0 end
redis.call('HDEL', KEYS[1], 'executionClaim')
return 1
`

function inputRequestField(key: string): string {
  return `${inputRequestPrefix}${key}`
}

function taskFailurePayload(error: unknown): Record<string, unknown> {
  const fields =
    typeof error === 'object' && error !== null ? (error as Record<string, unknown>) : {}
  const code = Number.isInteger(fields.code) ? fields.code : -32603
  return {
    code,
    message: error instanceof Error ? error.message : String(error),
    ...(fields.data !== undefined ? { data: fields.data } : {})
  }
}

function inputResponseField(key: string): string {
  return `${inputResponsePrefix}${key}`
}

function pendingInputRequests(hash: TaskHash): Record<string, TaskInputRequest> {
  const pending = Object.create(null) as Record<string, TaskInputRequest>
  for (const [field, value] of Object.entries(hash)) {
    if (!field.startsWith(inputRequestPrefix) || !value) continue
    const key = field.slice(inputRequestPrefix.length)
    if (hash[inputResponseField(key)]) continue
    pending[key] = JSON.parse(value) as TaskInputRequest
  }
  return pending
}
