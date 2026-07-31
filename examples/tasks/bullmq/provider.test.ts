import { afterEach, describe, expect, test } from 'bun:test'
import type { DetailedTask, TaskProviderContext } from '@mwillbanks/elysia-mcp-adapter'
import { BullMqTaskProvider } from './provider.js'

const providers: BullMqTaskProvider[] = []
afterEach(async () => {
  await Promise.all(providers.splice(0).map((provider) => provider[Symbol.asyncDispose]()))
})

const context = (principalKey: string): TaskProviderContext => ({
  version: '2026-07-28',
  principalKey
})

function provider(): BullMqTaskProvider {
  const value = new BullMqTaskProvider()
  providers.push(value)
  return value
}

async function waitForTerminal(
  tasks: BullMqTaskProvider,
  taskId: string,
  owner: TaskProviderContext
): Promise<DetailedTask> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const task = await tasks.get(taskId, owner)
    if (task && task.status !== 'working') return task
    await Bun.sleep(20)
  }
  throw new Error(`Task ${taskId} did not finish`)
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
          new Promise((resolve, reject) => {
            const timer = setTimeout(() => resolve({ ok: true }), 2_000)
            signal?.addEventListener('abort', () => {
              aborted = true
              clearTimeout(timer)
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
    for (let attempt = 0; attempt < 50 && !tasks.abortControllers.has(task.taskId); attempt += 1) {
      await Bun.sleep(10)
    }
    expect(await tasks.cancel(task.taskId, owner)).toBe(true)
    const cancelled = await waitForTerminal(tasks, task.taskId, owner)
    await Bun.sleep(20)
    await subscription.close()

    expect(cancelled.status).toBe('cancelled')
    expect(aborted).toBe(true)
    expect(events.some((event) => event.status === 'cancelled')).toBe(true)
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
    expect(await tasks.connection.lrange(`${tasks.prefix}:mock-wait`, 0, -1)).not.toContain(
      task.taskId
    )
  })

  test('persists MRTR requests, partial responses, and resumes the scheduler', async () => {
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
          return new Promise((resolve, reject) => {
            const timer = setTimeout(() => resolve({ ok: true }), 100)
            signal?.addEventListener('abort', () => {
              clearTimeout(timer)
              reject(signal.reason)
            })
          })
        }
      }
    )
    await tasks.get(task.taskId, owner)
    expect(
      await tasks.requestInput(
        task.taskId,
        'confirm',
        { method: 'elicitation/create', params: { message: 'Continue?' } },
        owner
      )
    ).toBe(true)
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

    expect(await tasks.update(task.taskId, { confirm: { accepted: true } }, owner)).toBe(true)
    expect((await tasks.get(task.taskId, owner))?.status).toBe('input_required')
    expect(await tasks.update(task.taskId, { roots: { roots: [] } }, owner)).toBe(true)
    expect(await tasks.requestInput(task.taskId, 'confirm', { method: 'roots/list' }, owner)).toBe(
      false
    )

    const completed = await waitForTerminal(tasks, task.taskId, owner)
    expect(completed.status).toBe('completed')
    expect(invocations).toBeGreaterThan(0)
    const storedResponses = await tasks.connection.hget(
      `${tasks.prefix}:task:${task.taskId}`,
      'inputResponses'
    )
    expect(JSON.parse(storedResponses ?? '{}')).toEqual({
      confirm: { accepted: true },
      roots: { roots: [] }
    })
  })
})
