import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DetailedTask, TaskProviderContext } from '@mwillbanks/elysia-mcp-adapter'
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

function trackedSignal(aborted: boolean): {
  signal: AbortSignal
  counts: () => readonly [number, number]
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
    counts: () => [added, removed]
  }
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

  test('completes tool-level errors instead of converting them to task failures', async () => {
    const { provider } = await fixture()
    const owner = context('tenant-a:user-1')
    const created = await provider.create(request('tool-error', 0), owner, {
      invoke: async () => ({})
    })
    const completed = await waitForTerminal(provider, created.taskId, owner)
    expect(completed).toMatchObject({
      status: 'completed',
      result: { isError: true }
    })
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
    expect(await provider.get(expiring.taskId, owner)).toBeDefined()
    await Bun.sleep(20)
    expect(await provider.get(expiring.taskId, owner)).toBeUndefined()
  })

  test('closes subscriptions during setup aborts and removes abort listeners', async () => {
    const { provider } = await fixture()
    const owner = context('tenant-a:user-1')
    const created = await provider.create(request('subscription', 2_000), owner, {
      invoke: async () => ({})
    })
    const normal = trackedSignal(false)
    const subscription = provider.listen([created.taskId], () => undefined, {
      ...owner,
      signal: normal.signal
    })
    subscription.close()
    subscription.close()
    expect(normal.counts()).toEqual([1, 1])

    const preAborted = trackedSignal(true)
    provider.listen([created.taskId], () => undefined, { ...owner, signal: preAborted.signal })
    expect(preAborted.counts()).toEqual([1, 1])
    await provider.cancel(created.taskId, owner)
  })

  test('reports listener failures through subscription completion', async () => {
    const { provider } = await fixture()
    const owner = context('tenant-a:user-1')
    const created = await provider.create(request('listener-error', 2_000), owner, {
      invoke: async () => ({})
    })
    const subscription = provider.listen(
      [created.taskId],
      () => {
        throw new Error('listener failed')
      },
      owner
    )
    await expect(subscription.done).rejects.toThrow('listener failed')
    await provider.cancel(created.taskId, owner)
  })

  test('makes zero-TTL tasks readable once without spawning orphaned work', async () => {
    const { provider } = await fixture()
    const owner = context('tenant-a:user-1')
    const created = await provider.create(request('expired', 1_000, 0), owner, {
      invoke: async () => ({})
    })

    expect(await provider.get(created.taskId, owner)).toEqual(created)
    expect(await provider.get(created.taskId, owner)).toBeUndefined()
    expect(provider.children.has(created.taskId)).toBe(false)
  })

  test('persists MRTR requests and partial responses without replaying execution', async () => {
    const { provider } = await fixture()
    const owner = context('tenant-a:user-1')
    const created = await provider.create(request('input', 500), owner, {
      invoke: async () => ({})
    })
    await provider.get(created.taskId, owner)

    expect(
      await provider.requestInput(
        created.taskId,
        'confirm',
        { method: 'elicitation/create', params: { message: 'Continue?' } },
        owner
      )
    ).toBe(true)
    expect(
      await provider.requestInput(created.taskId, 'roots', { method: 'roots/list' }, owner)
    ).toBe(true)
    expect(await provider.get(created.taskId, owner)).toMatchObject({
      status: 'input_required',
      inputRequests: {
        confirm: { method: 'elicitation/create' },
        roots: { method: 'roots/list' }
      }
    })

    expect(await provider.update(created.taskId, { confirm: { action: 'accept' } }, owner)).toBe(
      true
    )
    expect(
      await provider.update(
        created.taskId,
        Object.fromEntries([
          ['missing', { action: 'accept' }],
          ['__proto__', { action: 'accept' }]
        ]),
        owner
      )
    ).toBe(true)
    expect(await provider.update(created.taskId, { confirm: { action: 'accept' } }, owner)).toBe(
      true
    )
    expect(await provider.get(created.taskId, owner)).toMatchObject({
      status: 'input_required',
      inputRequests: { roots: { method: 'roots/list' } }
    })
    expect(await provider.update(created.taskId, { roots: { roots: [] } }, owner)).toBe(true)
    expect(
      await provider.requestInput(created.taskId, 'confirm', { method: 'roots/list' }, owner)
    ).toBe(false)
    const stored = provider.database
      .query<{ response: string }, [string, string]>(
        'SELECT response FROM task_input_requests WHERE task_id = ? AND request_key = ?'
      )
      .get(created.taskId, 'confirm')
    expect(JSON.parse(stored?.response ?? '{}')).toEqual({ action: 'accept' })
    expect((await provider.get(created.taskId, owner))?.status).toBe('working')
    await Bun.sleep(50)
    expect(provider.children.has(created.taskId)).toBe(false)
  })

  test('keeps worker completion atomic with input, response, and cancellation transitions', async () => {
    const { provider } = await fixture()
    const owner = context('tenant-a:user-1')

    for (let attempt = 0; attempt < 8; attempt += 1) {
      const inputTask = await provider.create(
        request(`input-race-${attempt}`, attempt % 2),
        owner,
        {
          invoke: async () => ({})
        }
      )
      const accepted = await provider.requestInput(
        inputTask.taskId,
        'confirm',
        { method: 'elicitation/create', params: { message: 'Continue?' } },
        owner
      )
      const inputRow = provider.database
        .query<{ status: string; result: string | null }, [string]>(
          'SELECT status, result FROM tasks WHERE task_id = ?'
        )
        .get(inputTask.taskId)
      const inputCount = provider.database
        .query<{ count: number }, [string]>(
          'SELECT COUNT(*) AS count FROM task_input_requests WHERE task_id = ?'
        )
        .get(inputTask.taskId)?.count
      if (accepted) {
        expect(inputRow).toMatchObject({ status: 'input_required', result: null })
        expect(inputCount).toBe(1)
      } else {
        if (!inputRow) throw new Error('Expected the raced input task to remain durable')
        expect(['completed', 'failed']).toContain(inputRow.status)
        expect(inputCount).toBe(0)
      }

      const cancelTask = await provider.create(
        request(`cancel-race-${attempt}`, attempt % 2),
        owner,
        { invoke: async () => ({}) }
      )
      expect(await provider.cancel(cancelTask.taskId, owner)).toBe(true)
      const cancelled = await provider.get(cancelTask.taskId, owner)
      if (!cancelled) throw new Error('Expected the raced cancellation task to remain durable')
      expect(['completed', 'failed', 'cancelled']).toContain(cancelled.status)
    }

    const terminal = await provider.create(request('terminal-guards', 2_000), owner, {
      invoke: async () => ({})
    })
    expect(
      await provider.requestInput(
        terminal.taskId,
        'confirm',
        { method: 'elicitation/create', params: { message: 'Continue?' } },
        owner
      )
    ).toBe(true)
    const terminalResult = JSON.stringify({ content: [{ type: 'text', text: 'already done' }] })
    provider.database
      .query("UPDATE tasks SET status = 'completed', result = ? WHERE task_id = ?")
      .run(terminalResult, terminal.taskId)

    expect(await provider.update(terminal.taskId, { confirm: { action: 'accept' } }, owner)).toBe(
      true
    )
    expect(
      await provider.requestInput(
        terminal.taskId,
        'late',
        { method: 'elicitation/create', params: { message: 'Too late?' } },
        owner
      )
    ).toBe(false)
    expect(await provider.cancel(terminal.taskId, owner)).toBe(true)
    const guarded = provider.database
      .query<
        { status: string; result: string | null; response: string | null; late: number },
        [string]
      >(
        `SELECT tasks.status, tasks.result, confirm.response,
                COUNT(late.request_key) AS late
         FROM tasks
         LEFT JOIN task_input_requests AS confirm
           ON confirm.task_id = tasks.task_id AND confirm.request_key = 'confirm'
         LEFT JOIN task_input_requests AS late
           ON late.task_id = tasks.task_id AND late.request_key = 'late'
         WHERE tasks.task_id = ?`
      )
      .get(terminal.taskId)
    expect(guarded).toEqual({
      status: 'completed',
      result: terminalResult,
      response: null,
      late: 0
    })
  })
})
