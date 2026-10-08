import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import type { DetailedTask, TaskProviderContext } from '@mwillbanks/elysia-mcp-adapter'
import { type RedisFixture, startRedisFixture, waitFor } from '../test-support.js'
import { BullMqTaskProvider, type BullMqTaskProviderOptions } from './provider.js'

const providers: BullMqTaskProvider[] = []
let redis: RedisFixture
beforeAll(async () => {
  redis = await startRedisFixture()
})
afterAll(async () => {
  await redis.close()
})
afterEach(async () => {
  await Promise.all(providers.splice(0).map((provider) => provider[Symbol.asyncDispose]()))
})

const context = (principalKey: string): TaskProviderContext => ({
  version: '2026-07-28',
  principalKey
})

function provider(options: BullMqTaskProviderOptions = {}): BullMqTaskProvider {
  const value = new BullMqTaskProvider({ redisUrl: redis.url, ...options })
  providers.push(value)
  return value
}

function executeRound(
  tasks: BullMqTaskProvider,
  taskId: string,
  token: string
): Promise<Record<string, unknown>> {
  return (
    tasks as unknown as {
      process(taskId: string, executionFence: string): Promise<Record<string, unknown>>
    }
  ).process(taskId, token)
}

function lockKey(tasks: BullMqTaskProvider, taskId: string): string {
  return `${tasks.queue.toKey(taskId)}:lock`
}

function trackedSignal(aborted: boolean): {
  signal: AbortSignal
  added: () => number
  removed: () => number
} {
  let added = 0
  let removed = 0
  return {
    signal: {
      aborted,
      addEventListener: () => {
        added += 1
      },
      removeEventListener: () => {
        removed += 1
      }
    } as unknown as AbortSignal,
    added: () => added,
    removed: () => removed
  }
}

async function waitForTerminal(
  tasks: BullMqTaskProvider,
  taskId: string,
  owner: TaskProviderContext
): Promise<DetailedTask> {
  return waitFor(`task ${taskId} to finish`, async () => {
    const task = await tasks.get(taskId, owner)
    if (task && task.status !== 'working') return task
  })
}

async function waitForActiveExecution(tasks: BullMqTaskProvider, taskId: string): Promise<void> {
  await waitFor(`task ${taskId} to start`, () => tasks.abortControllers.get(taskId))
}

describe('BullMQ task provider', () => {
  test('uses a real Worker with durable hashes and an ephemeral scheduler', async () => {
    const tasks = provider()
    const owner = context('tenant-a:user-1')
    const task = await tasks.create(
      {
        mode: 'required',
        execution: {
          method: 'tools/call',
          params: { name: 'reports.build', arguments: { id: 7 } }
        },
        ttlMs: 5_000,
        pollIntervalMs: 10
      },
      owner,
      { invoke: async () => ({ content: [{ type: 'text', text: 'ready' }] }) }
    )

    const hash = await tasks.connection.hgetall(`${tasks.prefix}:task:${task.taskId}`)
    expect(JSON.parse(hash.descriptor as string)).toEqual({
      method: 'tools/call',
      params: { name: 'reports.build', arguments: { id: 7 } }
    })
    expect(hash).not.toHaveProperty('scheduler')
    expect(JSON.stringify(hash)).not.toContain('invoke')
    expect(await tasks.get(task.taskId, context('tenant-b:user-1'))).toBeUndefined()

    const completed = await waitForTerminal(tasks, task.taskId, owner)
    expect(completed).toMatchObject({
      status: 'completed',
      result: { content: [{ text: 'ready' }] }
    })
  })

  test('completes tool errors and preserves JSON-RPC execution failures', async () => {
    const tasks = provider()
    const owner = context('tenant-a:user-1')
    const descriptor = {
      mode: 'required' as const,
      execution: { method: 'tools/call', params: { name: 'reports.build' } },
      ttlMs: 5_000
    }
    const toolError = await tasks.create(descriptor, owner, {
      invoke: async () => ({ isError: true, content: [{ type: 'text', text: 'expected' }] })
    })
    expect(await waitForTerminal(tasks, toolError.taskId, owner)).toMatchObject({
      status: 'completed',
      result: { isError: true }
    })

    const rpcFailure = await tasks.create(descriptor, owner, {
      invoke: async () => {
        throw Object.assign(new Error('Invalid task request'), {
          code: -32602,
          data: { field: 'name' }
        })
      }
    })
    expect(await waitForTerminal(tasks, rpcFailure.taskId, owner)).toMatchObject({
      status: 'failed',
      error: { code: -32602, message: 'Invalid task request', data: { field: 'name' } }
    })
  })

  test('publishes status events and cooperatively cancels active work', async () => {
    const tasks = provider()
    const owner = context('tenant-a:user-1')
    let aborted = false
    const task = await tasks.create(
      {
        mode: 'required',
        execution: { method: 'tools/call', params: { name: 'reports.slow' } }
      },
      owner,
      {
        invoke: (signal) =>
          new Promise((_, reject) => {
            signal?.addEventListener('abort', () => {
              aborted = true
              reject(signal.reason)
            })
          })
      }
    )
    const events: DetailedTask[] = []
    const subscription = await tasks.listen(
      [task.taskId],
      (event) => {
        events.push(event)
      },
      owner
    )
    await waitForActiveExecution(tasks, task.taskId)
    expect(await tasks.cancel(task.taskId, owner)).toBe(true)
    const cancelled = await waitForTerminal(tasks, task.taskId, owner)
    await waitFor('cancelled subscription event', () =>
      events.some((event) => event.status === 'cancelled') ? true : undefined
    )
    await subscription.close()

    expect(cancelled.status).toBe('cancelled')
    expect(aborted).toBe(true)
    expect(events.some((event) => event.status === 'cancelled')).toBe(true)
  })

  test('closes subscriptions during setup aborts and removes abort listeners', async () => {
    const tasks = provider()
    const owner = context('tenant-a:user-1')
    const task = await tasks.create(
      {
        mode: 'required',
        execution: { method: 'tools/call', params: { name: 'reports.subscription' } },
        ttlMs: 0
      },
      owner,
      { invoke: async () => ({ ok: true }) }
    )

    const normal = trackedSignal(false)
    const subscription = await tasks.listen([task.taskId], () => undefined, {
      ...owner,
      signal: normal.signal
    })
    await subscription.close()
    await subscription.close()
    expect([normal.added(), normal.removed()]).toEqual([1, 1])

    const preAborted = trackedSignal(true)
    await tasks.listen([task.taskId], () => undefined, { ...owner, signal: preAborted.signal })
    expect([preAborted.added(), preAborted.removed()]).toEqual([1, 1])
  })

  test('reports listener failures through subscription completion', async () => {
    const tasks = provider()
    const owner = context('tenant-a:user-1')
    const task = await tasks.create(
      {
        mode: 'required',
        execution: { method: 'tools/call', params: { name: 'reports.listener-error' } }
      },
      owner,
      {
        invoke: (signal) =>
          new Promise((_, reject) => {
            signal?.addEventListener('abort', () => reject(signal.reason))
          })
      }
    )
    const subscription = await tasks.listen(
      [task.taskId],
      () => {
        throw new Error('listener failed')
      },
      owner
    )
    expect(await tasks.cancel(task.taskId, owner)).toBe(true)
    await expect(subscription.done).rejects.toThrow('listener failed')
  })

  test('makes zero-TTL tasks readable once and removes scheduling state', async () => {
    const tasks = provider()
    const owner = context('tenant-a:user-1')
    const task = await tasks.create(
      {
        mode: 'required',
        execution: { method: 'tools/call', params: { name: 'reports.expired' } },
        ttlMs: 0
      },
      owner,
      { invoke: async () => ({ ok: true }) }
    )

    expect(await tasks.get(task.taskId, owner)).toEqual(task)
    expect(await tasks.get(task.taskId, owner)).toBeUndefined()
    expect(tasks.schedulers.has(task.taskId)).toBe(false)
    expect(await tasks.queue.getJob(task.taskId)).toBeUndefined()
  })

  test('recovers queued work and durable records after provider reconstruction', async () => {
    const queueName = `tasks-restart-${crypto.randomUUID()}`
    const owner = context('tenant-a:user-1')
    const original = provider({ queueName, startWorker: false })
    const queued = await original.create(
      {
        mode: 'required',
        execution: {
          method: 'tools/call',
          params: { name: 'reports.recover', arguments: { id: 9 } }
        },
        ttlMs: 5_000
      },
      owner,
      { invoke: async () => ({ unreachable: true }) }
    )
    await original[Symbol.asyncDispose]()
    providers.splice(providers.indexOf(original), 1)

    let resolvedDescriptor: unknown
    let resolvedContext: unknown
    const recovered = provider({
      queueName,
      resolveScheduler(descriptor, providerContext) {
        resolvedDescriptor = descriptor
        resolvedContext = providerContext
        return { invoke: async () => ({ recovered: true }) }
      }
    })
    expect(await waitForTerminal(recovered, queued.taskId, owner)).toMatchObject({
      status: 'completed',
      result: { recovered: true }
    })
    expect(resolvedDescriptor).toEqual({
      method: 'tools/call',
      params: { name: 'reports.recover', arguments: { id: 9 } }
    })
    expect(resolvedContext).toMatchObject({
      version: '2026-07-28',
      principalKey: 'tenant-a:user-1'
    })

    await recovered[Symbol.asyncDispose]()
    providers.splice(providers.indexOf(recovered), 1)
    const reader = provider({ queueName, startWorker: false })
    expect(await reader.get(queued.taskId, owner)).toMatchObject({
      status: 'completed',
      result: { recovered: true }
    })

    const waiting = await reader.create(
      {
        mode: 'required',
        execution: { method: 'tools/call', params: { name: 'reports.await-input' } },
        ttlMs: 5_000
      },
      owner,
      { invoke: async () => ({ unreachable: true }) }
    )
    expect(
      await reader.requestInput(
        waiting.taskId,
        'confirm',
        { method: 'elicitation/create', params: { message: 'Continue?' } },
        owner
      )
    ).toBe(true)
    expect(
      await reader.requestInput(waiting.taskId, 'roots', { method: 'roots/list' }, owner)
    ).toBe(true)
    await reader[Symbol.asyncDispose]()
    providers.splice(providers.indexOf(reader), 1)

    const resumed = provider({ queueName, startWorker: false })
    expect(await resumed.get(waiting.taskId, owner)).toMatchObject({
      status: 'input_required',
      inputRequests: { confirm: { method: 'elicitation/create' }, roots: { method: 'roots/list' } }
    })
    expect(await resumed.update(waiting.taskId, { confirm: { action: 'accept' } }, owner)).toBe(
      true
    )
    expect(await resumed.get(waiting.taskId, owner)).toMatchObject({
      status: 'input_required',
      inputRequests: { roots: { method: 'roots/list' } }
    })
  })

  test('does not invoke dequeued work across cancellation or input-required resolver gaps', async () => {
    for (const transition of ['cancel', 'input'] as const) {
      const queueName = `tasks-resolver-race-${transition}-${crypto.randomUUID()}`
      const owner = context('tenant-a:user-1')
      const producer = provider({ queueName, startWorker: false })
      const queued = await producer.create(
        {
          mode: 'required',
          execution: { method: 'tools/call', params: { name: `reports.${transition}` } }
        },
        owner,
        { invoke: async () => ({ unreachable: true }) }
      )
      await producer[Symbol.asyncDispose]()
      providers.splice(providers.indexOf(producer), 1)

      let signalResolverStarted!: () => void
      let releaseResolver!: () => void
      const resolverStarted = new Promise<void>((resolve) => {
        signalResolverStarted = resolve
      })
      const resolverGate = new Promise<void>((resolve) => {
        releaseResolver = resolve
      })
      let sideEffects = 0
      const consumer = provider({
        queueName,
        async resolveScheduler() {
          signalResolverStarted()
          await resolverGate
          return {
            invoke: async () => {
              sideEffects += 1
              return { unexpected: true }
            }
          }
        }
      })
      await resolverStarted
      if (transition === 'cancel') {
        expect(await consumer.cancel(queued.taskId, owner)).toBe(true)
        releaseResolver()
      } else {
        const request = consumer.requestInput(
          queued.taskId,
          'confirm',
          { method: 'elicitation/create', params: { message: 'Continue?' } },
          owner
        )
        await waitFor('input-required transition', async () =>
          (await consumer.get(queued.taskId, owner))?.status === 'input_required' ? true : undefined
        )
        releaseResolver()
        expect(await request).toBe(true)
      }
      await waitFor('resolver round to finish', async () => {
        const job = await consumer.queue.getJob(queued.taskId)
        if (!job) return true
        return (await job.isCompleted()) || (await job.isFailed()) ? true : undefined
      })
      expect(sideEffects).toBe(0)
      expect((await consumer.get(queued.taskId, owner))?.status).toBe(
        transition === 'cancel' ? 'cancelled' : 'input_required'
      )
    }
  })

  test('fences duplicate rounds and lets a new BullMQ lock supersede an orphaned claim', async () => {
    const owner = context('tenant-a:user-1')

    const duplicateProvider = provider({ startWorker: false })
    let releaseDuplicate!: () => void
    const duplicateGate = new Promise<void>((resolve) => {
      releaseDuplicate = resolve
    })
    let duplicateInvocations = 0
    const duplicate = await duplicateProvider.create(
      {
        mode: 'required',
        execution: { method: 'tools/call', params: { name: 'reports.duplicate' } }
      },
      owner,
      {
        async invoke() {
          duplicateInvocations += 1
          await duplicateGate
          return { round: 'only' }
        }
      }
    )
    const duplicateToken = `token-${crypto.randomUUID()}`
    await duplicateProvider.connection.set(
      lockKey(duplicateProvider, duplicate.taskId),
      duplicateToken
    )
    const first = executeRound(duplicateProvider, duplicate.taskId, duplicateToken)
    await waitFor('duplicate execution to start', () =>
      duplicateInvocations === 1 ? true : undefined
    )
    expect(duplicateInvocations).toBe(1)
    expect(await executeRound(duplicateProvider, duplicate.taskId, duplicateToken)).toEqual({})
    releaseDuplicate()
    await first
    expect(duplicateInvocations).toBe(1)
    expect(await duplicateProvider.get(duplicate.taskId, owner)).toMatchObject({
      status: 'completed',
      result: { round: 'only' }
    })

    const recoveryProvider = provider({ startWorker: false })
    let releaseOld!: () => void
    const oldGate = new Promise<void>((resolve) => {
      releaseOld = resolve
    })
    let recoveryInvocations = 0
    const recovered = await recoveryProvider.create(
      {
        mode: 'required',
        execution: { method: 'tools/call', params: { name: 'reports.recovery-fence' } }
      },
      owner,
      {
        async invoke() {
          recoveryInvocations += 1
          if (recoveryInvocations === 1) {
            await oldGate
            return { round: 'old' }
          }
          return { round: 'recovered' }
        }
      }
    )
    const oldToken = `token-old-${crypto.randomUUID()}`
    const newToken = `token-new-${crypto.randomUUID()}`
    await recoveryProvider.connection.set(lockKey(recoveryProvider, recovered.taskId), oldToken)
    const oldRound = executeRound(recoveryProvider, recovered.taskId, oldToken)
    await waitFor('orphaned execution to start', () =>
      recoveryInvocations === 1 ? true : undefined
    )
    expect(recoveryInvocations).toBe(1)
    await recoveryProvider.connection.set(lockKey(recoveryProvider, recovered.taskId), newToken)
    await executeRound(recoveryProvider, recovered.taskId, newToken)
    releaseOld()
    await oldRound
    expect(recoveryInvocations).toBe(2)
    expect(await recoveryProvider.get(recovered.taskId, owner)).toMatchObject({
      status: 'completed',
      result: { round: 'recovered' }
    })
  })

  test('prevents a paused round from overwriting a task resumed after input', async () => {
    const tasks = provider({ startWorker: false })
    const owner = context('tenant-a:user-1')
    let releaseOld!: () => void
    const oldGate = new Promise<void>((resolve) => {
      releaseOld = resolve
    })
    let invocations = 0
    const task = await tasks.create(
      {
        mode: 'required',
        execution: { method: 'tools/call', params: { name: 'reports.paused-round' } }
      },
      owner,
      {
        async invoke() {
          invocations += 1
          if (invocations === 1) {
            await oldGate
            return { stale: true }
          }
          return { resumed: true }
        }
      }
    )
    const oldToken = `token-paused-${crypto.randomUUID()}`
    await tasks.connection.set(lockKey(tasks, task.taskId), oldToken)
    const oldRound = executeRound(tasks, task.taskId, oldToken)
    tasks.executions.set(task.taskId, new Set([oldRound]))
    await waitFor('paused execution to start', () => (invocations === 1 ? true : undefined))

    const inputTransition = tasks.requestInput(
      task.taskId,
      'confirm',
      { method: 'elicitation/create', params: { message: 'Continue?' } },
      owner
    )
    await waitFor('paused execution input transition', async () =>
      (await tasks.get(task.taskId, owner))?.status === 'input_required' ? true : undefined
    )
    expect(await tasks.update(task.taskId, { confirm: { action: 'accept' } }, owner)).toBe(true)
    const resumedToken = `token-resumed-${crypto.randomUUID()}`
    await tasks.connection.set(lockKey(tasks, task.taskId), resumedToken)
    await executeRound(tasks, task.taskId, resumedToken)
    releaseOld()
    await oldRound
    await inputTransition
    tasks.executions.delete(task.taskId)

    expect(invocations).toBe(2)
    expect(await tasks.get(task.taskId, owner)).toMatchObject({
      status: 'completed',
      result: { resumed: true }
    })
  })

  test('preserves an active execution fence for unknown and answered input keys', async () => {
    const owner = context('tenant-a:user-1')
    let releaseExecution!: () => void
    const executionGate = new Promise<void>((resolve) => {
      releaseExecution = resolve
    })
    let invocations = 0
    const scheduler = {
      async invoke() {
        invocations += 1
        await executionGate
        return { completed: true }
      }
    }
    const tasks = provider({ startWorker: false, resolveScheduler: () => scheduler })
    const task = await tasks.create(
      {
        mode: 'required',
        execution: { method: 'tools/call', params: { name: 'reports.no-op-input' } }
      },
      owner,
      scheduler
    )
    expect(
      await tasks.requestInput(
        task.taskId,
        'confirm',
        { method: 'elicitation/create', params: { message: 'Continue?' } },
        owner
      )
    ).toBe(true)
    expect(await tasks.update(task.taskId, { confirm: { action: 'accept' } }, owner)).toBe(true)

    const executionToken = `token-no-op-${crypto.randomUUID()}`
    await tasks.connection.set(lockKey(tasks, task.taskId), executionToken)
    const execution = executeRound(tasks, task.taskId, executionToken)
    await waitFor('active execution fence', () => (invocations === 1 ? true : undefined))
    expect(invocations).toBe(1)

    const taskKey = `${tasks.prefix}:task:${task.taskId}`
    const before = await tasks.connection.hmget(
      taskKey,
      'status',
      'lastUpdatedAt',
      'executionClaim'
    )
    expect(before).toEqual(['working', expect.any(String), executionToken])
    expect(await tasks.queue.getJob(task.taskId)).toBeUndefined()
    const subscriber = tasks.connection.duplicate()
    let published = 0
    subscriber.on('message', () => {
      published += 1
    })
    try {
      await subscriber.subscribe(tasks.channel)
      expect(
        await tasks.update(
          task.taskId,
          { confirm: { action: 'accept' }, unknown: { ignored: true } },
          owner
        )
      ).toBe(true)
      expect(published).toBe(0)
      expect(
        await tasks.connection.hmget(taskKey, 'status', 'lastUpdatedAt', 'executionClaim')
      ).toEqual(before)
      expect(await tasks.queue.getJob(task.taskId)).toBeUndefined()
      expect(await tasks.update(crypto.randomUUID(), { unknown: {} }, owner)).toBe(false)
    } finally {
      await subscriber.unsubscribe()
      subscriber.disconnect()
    }

    releaseExecution()
    await execution
    expect(await tasks.get(task.taskId, owner)).toMatchObject({
      status: 'completed',
      result: { completed: true }
    })
    const terminal = await tasks.connection.hgetall(taskKey)
    expect(await tasks.update(task.taskId, { confirm: { action: 'accept' } }, owner)).toBe(true)
    expect(await tasks.connection.hgetall(taskKey)).toEqual(terminal)
  })

  test('atomically persists MRTR requests and partial responses without replaying execution', async () => {
    const tasks = provider()
    const owner = context('tenant-a:user-1')
    let invocations = 0
    const task = await tasks.create(
      {
        mode: 'required',
        execution: { method: 'tools/call', params: { name: 'reports.input' } },
        ttlMs: 5_000
      },
      owner,
      {
        async invoke(signal) {
          invocations += 1
          return new Promise((_, reject) => {
            signal?.addEventListener('abort', () => {
              reject(signal.reason)
            })
          })
        }
      }
    )
    await tasks.get(task.taskId, owner)
    await waitForActiveExecution(tasks, task.taskId)
    const duplicateClaims = await Promise.all([
      tasks.requestInput(
        task.taskId,
        'confirm',
        { method: 'elicitation/create', params: { message: 'Continue?' } },
        owner
      ),
      tasks.requestInput(
        task.taskId,
        'confirm',
        { method: 'elicitation/create', params: { message: 'Duplicate' } },
        owner
      )
    ])
    expect(duplicateClaims.sort()).toEqual([false, true])
    expect(await tasks.requestInput(task.taskId, 'roots', { method: 'roots/list' }, owner)).toBe(
      true
    )
    expect(await tasks.get(task.taskId, owner)).toMatchObject({
      status: 'input_required',
      inputRequests: {
        confirm: { method: 'elicitation/create' },
        roots: { method: 'roots/list' }
      }
    })

    expect(await tasks.update(task.taskId, { confirm: { action: 'accept' } }, owner)).toBe(true)
    expect(
      await tasks.update(
        task.taskId,
        Object.fromEntries([
          ['missing', { action: 'accept' }],
          ['__proto__', { action: 'accept' }]
        ]),
        owner
      )
    ).toBe(true)
    expect(await tasks.update(task.taskId, { confirm: { action: 'accept' } }, owner)).toBe(true)
    expect((await tasks.get(task.taskId, owner))?.status).toBe('input_required')
    expect(await tasks.update(task.taskId, { roots: { roots: [] } }, owner)).toBe(true)
    expect(await tasks.requestInput(task.taskId, 'confirm', { method: 'roots/list' }, owner)).toBe(
      false
    )

    await waitFor('aborted input execution cleanup', () =>
      !tasks.abortControllers.has(task.taskId) && !tasks.executions.has(task.taskId)
        ? true
        : undefined
    )
    expect((await tasks.get(task.taskId, owner))?.status).toBe('working')
    expect(invocations).toBe(1)
    expect(tasks.schedulers.has(task.taskId)).toBe(false)
    const storedResponses = await tasks.connection.hget(
      `${tasks.prefix}:task:${task.taskId}`,
      'input-response:confirm'
    )
    expect(JSON.parse(storedResponses ?? '{}')).toEqual({ action: 'accept' })
  })

  test('keeps cancellation terminal across concurrent input transitions', async () => {
    const tasks = provider()
    const owner = context('tenant-a:user-1')

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const task = await tasks.create(
        {
          mode: 'required',
          execution: { method: 'tools/call', params: { name: `reports.race-${attempt}` } }
        },
        owner,
        {
          invoke: (signal) =>
            new Promise((_, reject) => {
              signal?.addEventListener('abort', () => reject(signal.reason))
            })
        }
      )
      await waitForActiveExecution(tasks, task.taskId)

      const [, cancelled] = await Promise.all([
        tasks.requestInput(
          task.taskId,
          'confirm',
          { method: 'elicitation/create', params: { message: 'Continue?' } },
          owner
        ),
        tasks.cancel(task.taskId, owner)
      ])

      expect(cancelled).toBe(true)
      expect((await tasks.get(task.taskId, owner))?.status).toBe('cancelled')
    }
  })

  test('does not let input updates or late workers overwrite cancellation', async () => {
    const tasks = provider()
    const owner = context('tenant-a:user-1')
    let resolveExecution: ((result: Record<string, unknown>) => void) | undefined
    const task = await tasks.create(
      {
        mode: 'required',
        execution: { method: 'tools/call', params: { name: 'reports.late-result' } }
      },
      owner,
      {
        invoke: () =>
          new Promise((resolve) => {
            resolveExecution = resolve
          })
      }
    )
    await waitForActiveExecution(tasks, task.taskId)
    expect(await tasks.cancel(task.taskId, owner)).toBe(true)
    resolveExecution?.({ tooLate: true })
    await Promise.allSettled(tasks.executions.get(task.taskId) ?? [])
    expect((await tasks.get(task.taskId, owner))?.status).toBe('cancelled')

    const inputTask = await tasks.create(
      {
        mode: 'required',
        execution: { method: 'tools/call', params: { name: 'reports.update-race' } }
      },
      owner,
      {
        invoke: (signal) =>
          new Promise((_, reject) => {
            signal?.addEventListener('abort', () => reject(signal.reason))
          })
      }
    )
    await waitForActiveExecution(tasks, inputTask.taskId)
    expect(
      await tasks.requestInput(
        inputTask.taskId,
        'confirm',
        { method: 'elicitation/create', params: { message: 'Continue?' } },
        owner
      )
    ).toBe(true)
    const [, cancelled] = await Promise.all([
      tasks.update(inputTask.taskId, { confirm: { action: 'accept' } }, owner),
      tasks.cancel(inputTask.taskId, owner)
    ])
    expect(cancelled).toBe(true)
    expect((await tasks.get(inputTask.taskId, owner))?.status).toBe('cancelled')
  })
})
