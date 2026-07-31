import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DetailedTask, TaskProviderContext } from '../../../src/index.js'
import { SqliteSubprocessTaskProvider } from './provider.js'

const disposals: Array<() => Promise<void>> = []
afterEach(async () => {
  await Promise.all(disposals.splice(0).map((dispose) => dispose()))
})

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'elysia-tasks-'))
  const databasePath = join(directory, 'tasks.sqlite')
  const provider = new SqliteSubprocessTaskProvider(databasePath)
  disposals.push(async () => {
    await provider[Symbol.asyncDispose]()
    await rm(directory, { recursive: true, force: true })
  })
  return { provider, databasePath }
}

const context = (principalKey: string): TaskProviderContext => ({
  version: '2026-07-28',
  principalKey
})

const request = (value: string, delayMs: number, ttlMs: number | null = 5_000) => ({
  mode: 'required' as const,
  ttlMs,
  pollIntervalMs: 10,
  execution: {
    method: 'tools/call',
    params: { name: 'tasks.run', arguments: { body: { value, delayMs } } }
  }
})

async function waitForTerminal(
  provider: SqliteSubprocessTaskProvider,
  taskId: string,
  owner: TaskProviderContext
): Promise<DetailedTask> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const task = await provider.get(taskId, owner)
    if (task && task.status !== 'working') return task
    await Bun.sleep(20)
  }
  throw new Error(`Task ${taskId} did not finish`)
}

describe('SQLite subprocess task provider', () => {
  test('runs through MCP in a distinct Bun child and survives provider reconstruction', async () => {
    const { provider, databasePath } = await fixture()
    const owner = context('tenant-a:user-1')
    const created = await provider.create(request('done', 30), owner, {
      invoke: async () => {
        throw new Error('the scheduler must not be invoked or persisted')
      }
    })
    expect(created.status).toBe('working')

    const completed = await waitForTerminal(provider, created.taskId, owner)
    expect(completed).toMatchObject({
      status: 'completed',
      result: { structuredContent: { value: 'done' } }
    })
    if (completed.status !== 'completed') throw new Error('Expected the task to complete')
    const structuredContent = completed.result.structuredContent as { childPid: number }
    expect(structuredContent.childPid).not.toBe(process.pid)
    expect(await provider.get(created.taskId, context('tenant-b:user-1'))).toBeUndefined()

    const reopened = new SqliteSubprocessTaskProvider(databasePath)
    disposals.push(() => reopened[Symbol.asyncDispose]())
    expect(await reopened.get(created.taskId, owner)).toEqual(completed)
  })

  test('polls status notifications, cancels work, and expires TTL records', async () => {
    const { provider } = await fixture()
    const owner = context('tenant-a:user-1')
    const created = await provider.create(request('slow', 2_000), owner, {
      invoke: async () => ({})
    })
    const events: DetailedTask[] = []
    const subscription = provider.listen(
      [created.taskId],
      (task) => {
        events.push(task)
      },
      owner
    )
    await Bun.sleep(30)
    expect(await provider.cancel(created.taskId, owner)).toBe(true)
    const cancelled = await waitForTerminal(provider, created.taskId, owner)
    expect(cancelled.status).toBe('cancelled')
    await Bun.sleep(30)
    subscription.close()
    expect(events.some((event) => event.status === 'cancelled')).toBe(true)

    const expiring = await provider.create(request('ttl', 1_000, 10), owner, {
      invoke: async () => ({})
    })
    await Bun.sleep(20)
    expect(await provider.get(expiring.taskId, owner)).toBeUndefined()
  })
})
