import { Database } from 'bun:sqlite'
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

interface TaskRow {
  task_id: string
  principal_key: string
  status: DetailedTask['status']
  created_at: string
  updated_at: string
  ttl_ms: number | null
  poll_interval_ms: number | null
  result: string | null
  error: string | null
  expiry_armed: number
}

interface InputRequestRow {
  request_key: string
  request: string
}

const terminalStatuses = new Set<DetailedTask['status']>(['completed', 'failed', 'cancelled'])

export class SqliteSubprocessTaskProvider implements TaskProvider, AsyncDisposable {
  readonly database: Database
  readonly children = new Map<string, Bun.Subprocess>()
  readonly workerPath: string
  private disposed = false

  constructor(readonly databasePath: string) {
    this.database = new Database(databasePath, { create: true })
    this.database.exec('PRAGMA journal_mode = WAL')
    this.database.exec('PRAGMA busy_timeout = 5000')
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        task_id TEXT PRIMARY KEY,
        principal_key TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        ttl_ms INTEGER,
        poll_interval_ms INTEGER,
        descriptor TEXT NOT NULL,
        result TEXT,
        error TEXT,
        child_pid INTEGER,
        expiry_armed INTEGER NOT NULL DEFAULT 0
      )
    `)
    const taskColumns = this.database
      .query<{ name: string }, []>('PRAGMA table_info(tasks)')
      .all()
      .map(({ name }) => name)
    if (!taskColumns.includes('expiry_armed')) {
      this.database.exec('ALTER TABLE tasks ADD COLUMN expiry_armed INTEGER NOT NULL DEFAULT 0')
    }
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS task_input_requests (
        task_id TEXT NOT NULL,
        request_key TEXT NOT NULL,
        request TEXT NOT NULL,
        response TEXT,
        PRIMARY KEY (task_id, request_key),
        FOREIGN KEY (task_id) REFERENCES tasks(task_id) ON DELETE CASCADE
      )
    `)
    this.workerPath = new URL('./worker.ts', import.meta.url).pathname
  }

  async create(
    request: TaskDurableCreateRequest,
    context: TaskProviderContext,
    _scheduler: TaskExecutionScheduler
  ): Promise<DetailedTask> {
    const taskId = crypto.randomUUID()
    const now = new Date().toISOString()
    const ttlMs = request.ttlMs ?? null
    const pollIntervalMs = request.pollIntervalMs ?? 25
    this.database
      .query(
        `INSERT INTO tasks
          (task_id, principal_key, status, created_at, updated_at, ttl_ms, poll_interval_ms, descriptor)
         VALUES (?, ?, 'working', ?, ?, ?, ?, ?)`
      )
      .run(
        taskId,
        principal(context),
        now,
        now,
        ttlMs,
        pollIntervalMs,
        JSON.stringify(request.execution)
      )

    const created: DetailedTask = {
      taskId,
      status: 'working',
      createdAt: now,
      lastUpdatedAt: now,
      ttlMs,
      pollIntervalMs
    }
    if (ttlMs === 0) return created

    this.startWorker(taskId)
    return created
  }

  async get(taskId: string, context: TaskProviderContext): Promise<DetailedTask | undefined> {
    const row = this.database
      .query<TaskRow, [string, string]>(
        'SELECT * FROM tasks WHERE task_id = ? AND principal_key = ?'
      )
      .get(taskId, principal(context))
    if (!row) return undefined
    if (row.ttl_ms !== null && row.expiry_armed === 0) {
      this.database.query('UPDATE tasks SET expiry_armed = 1 WHERE task_id = ?').run(taskId)
      if (row.ttl_ms === 0) {
        this.expire(taskId)
      }
      return this.toTask(row)
    }
    if (row.ttl_ms !== null && Date.parse(row.created_at) + row.ttl_ms <= Date.now()) {
      this.expire(taskId)
      return undefined
    }
    return this.toTask(row)
  }

  async update(
    taskId: string,
    inputResponses: TaskInputResponses,
    context: TaskProviderContext
  ): Promise<boolean> {
    const updateResponse = this.database.query(
      `UPDATE task_input_requests SET response = ?
       WHERE task_id = ? AND request_key = ? AND response IS NULL
         AND EXISTS (
           SELECT 1 FROM tasks
           WHERE task_id = ? AND principal_key = ?
             AND status IN ('working', 'input_required')
         )`
    )
    const transaction = this.database.transaction((): boolean => {
      const row = this.database
        .query<TaskRow, [string, string]>(
          'SELECT * FROM tasks WHERE task_id = ? AND principal_key = ?'
        )
        .get(taskId, principal(context))
      if (!row) return false
      if (terminalStatuses.has(row.status)) return true
      const outstandingRequests = new Map(
        this.pendingInputRequests(taskId).map((entry) => [entry.request_key, entry] as const)
      )
      const accepted = Object.entries(inputResponses).flatMap(([key, response]) => {
        const outstanding = outstandingRequests.get(key)
        if (!outstanding) return []
        assertTaskInputResponse(
          JSON.parse(outstanding.request) as TaskInputRequest,
          response,
          'task input response',
          context.version
        )
        return [[key, response] as const]
      })
      for (const [key, response] of accepted) {
        updateResponse.run(JSON.stringify(response), taskId, key, taskId, principal(context))
      }
      const pending = this.pendingInputRequests(taskId)
      const transitioned = this.database
        .query(
          `UPDATE tasks SET status = ?, updated_at = ?
           WHERE task_id = ? AND principal_key = ?
             AND status IN ('working', 'input_required')`
        )
        .run(
          pending.length === 0 ? 'working' : 'input_required',
          new Date().toISOString(),
          taskId,
          principal(context)
        )
      return transitioned.changes === 1
    })
    return transaction.immediate()
  }

  async requestInput(
    taskId: string,
    key: string,
    request: TaskInputRequest,
    context: TaskProviderContext
  ): Promise<boolean> {
    const transaction = this.database.transaction((): boolean => {
      const task = this.database
        .query<Pick<TaskRow, 'status'>, [string, string]>(
          'SELECT status FROM tasks WHERE task_id = ? AND principal_key = ?'
        )
        .get(taskId, principal(context))
      if (!task || terminalStatuses.has(task.status)) return false
      const inserted = this.database
        .query(
          `INSERT OR IGNORE INTO task_input_requests (task_id, request_key, request)
           VALUES (?, ?, ?)`
        )
        .run(taskId, key, JSON.stringify(request))
      if (inserted.changes !== 1) return false
      const transitioned = this.database
        .query(
          `UPDATE tasks SET status = 'input_required', updated_at = ?
           WHERE task_id = ? AND principal_key = ?
             AND status IN ('working', 'input_required')`
        )
        .run(new Date().toISOString(), taskId, principal(context))
      return transitioned.changes === 1
    })
    if (!transaction.immediate()) return false
    const child = this.children.get(taskId)
    if (child) {
      child.kill('SIGTERM')
      await child.exited
      if (this.children.get(taskId) === child) this.children.delete(taskId)
    }
    return true
  }

  async cancel(taskId: string, context: TaskProviderContext): Promise<boolean> {
    const transaction = this.database.transaction((): 'missing' | 'terminal' | 'cancelled' => {
      const task = this.database
        .query<Pick<TaskRow, 'status'>, [string, string]>(
          'SELECT status FROM tasks WHERE task_id = ? AND principal_key = ?'
        )
        .get(taskId, principal(context))
      if (!task) return 'missing'
      if (terminalStatuses.has(task.status)) return 'terminal'
      const transitioned = this.database
        .query(
          `UPDATE tasks SET status = 'cancelled', result = NULL, error = NULL, updated_at = ?
           WHERE task_id = ? AND principal_key = ?
             AND status IN ('working', 'input_required')`
        )
        .run(new Date().toISOString(), taskId, principal(context))
      return transitioned.changes === 1 ? 'cancelled' : 'terminal'
    })
    const outcome = transaction.immediate()
    if (outcome === 'missing') return false
    if (outcome === 'terminal') return true
    this.children.get(taskId)?.kill('SIGTERM')
    return true
  }

  listen(
    taskIds: readonly string[],
    listener: TaskStatusListener,
    context: TaskSubscriptionContext
  ): TaskSubscription {
    let closed = false
    let running = false
    let resolveDone!: () => void
    let rejectDone!: (error: unknown) => void
    const done = new Promise<void>((resolve, reject) => {
      resolveDone = resolve
      rejectDone = reject
    })
    void done.catch(() => undefined)
    const acceptedTaskIds = taskIds.filter((taskId) => {
      const row = this.database
        .query<{ count: number }, [string, string]>(
          'SELECT COUNT(*) AS count FROM tasks WHERE task_id = ? AND principal_key = ?'
        )
        .get(taskId, principal(context))
      return (row?.count ?? 0) > 0
    })
    const seen = new Map<string, string>()
    const close = (cause?: unknown) => {
      if (closed) return
      closed = true
      context.signal?.removeEventListener('abort', onAbort)
      clearInterval(timer)
      if (cause !== undefined) rejectDone(cause)
      else resolveDone()
    }
    const onAbort = () => close()
    const stopped = () => closed || Boolean(context.signal?.aborted)
    const pollTask = async (taskId: string) => {
      if (stopped()) return
      const task = await this.get(taskId, context)
      if (stopped() || !task) return
      const fingerprint = `${task.status}:${task.lastUpdatedAt}`
      if (seen.get(taskId) === fingerprint) return
      seen.set(taskId, fingerprint)
      await listener(task)
    }
    const allTerminal = () =>
      acceptedTaskIds.length > 0 &&
      acceptedTaskIds.every((taskId) => {
        const status = seen.get(taskId)?.split(':', 1)[0] as DetailedTask['status'] | undefined
        return status !== undefined && terminalStatuses.has(status)
      })
    const tick = async () => {
      if (closed || running || context.signal?.aborted) return
      running = true
      try {
        for (const taskId of acceptedTaskIds) await pollTask(taskId)
        if (stopped()) return
        if (allTerminal()) close()
      } catch (error) {
        close(error)
      } finally {
        running = false
      }
    }
    const timer = setInterval(() => void tick(), 10)
    context.signal?.addEventListener('abort', onAbort, { once: true })
    if (context.signal?.aborted) close()
    return { acceptedTaskIds, close, done }
  }

  async [Symbol.asyncDispose](): Promise<void> {
    this.disposed = true
    for (const child of this.children.values()) child.kill()
    await Promise.all([...this.children.values()].map((child) => child.exited))
    this.database.close()
  }

  private expire(taskId: string): void {
    this.children.get(taskId)?.kill()
    this.children.delete(taskId)
    this.database.query('DELETE FROM task_input_requests WHERE task_id = ?').run(taskId)
    this.database.query('DELETE FROM tasks WHERE task_id = ?').run(taskId)
  }

  private startWorker(taskId: string): void {
    if (this.children.has(taskId)) return
    const child = Bun.spawn([process.execPath, this.workerPath, this.databasePath, taskId], {
      stdout: 'ignore',
      stderr: 'inherit'
    })
    this.children.set(taskId, child)
    this.database.query('UPDATE tasks SET child_pid = ? WHERE task_id = ?').run(child.pid, taskId)
    void child.exited.then((exitCode) => {
      if (this.children.get(taskId) === child) this.children.delete(taskId)
      if (exitCode !== 0 && !this.disposed) {
        this.database
          .query(
            `UPDATE tasks SET status = 'failed', error = ?, updated_at = ?
             WHERE task_id = ? AND status = 'working'`
          )
          .run(
            JSON.stringify({ code: -32603, message: `Worker exited with code ${exitCode}` }),
            new Date().toISOString(),
            taskId
          )
      }
    })
  }

  private pendingInputRequests(taskId: string): InputRequestRow[] {
    return this.database
      .query<InputRequestRow, [string]>(
        `SELECT request_key, request FROM task_input_requests
         WHERE task_id = ? AND response IS NULL ORDER BY request_key`
      )
      .all(taskId)
  }

  private toTask(row: TaskRow): DetailedTask {
    const inputRequests = Object.fromEntries(
      this.pendingInputRequests(row.task_id).map(({ request_key, request }) => [
        request_key,
        JSON.parse(request) as TaskInputRequest
      ])
    )
    return toTask(row, inputRequests)
  }
}

function principal(context: TaskProviderContext): string {
  return context.principalKey ?? ''
}

function toTask(row: TaskRow, inputRequests: Record<string, TaskInputRequest>): DetailedTask {
  const base = {
    taskId: row.task_id,
    createdAt: row.created_at,
    lastUpdatedAt: row.updated_at,
    ttlMs: row.ttl_ms,
    pollIntervalMs: row.poll_interval_ms ?? undefined
  }
  if (row.status === 'completed') {
    return { ...base, status: 'completed', result: JSON.parse(row.result ?? '{}') }
  }
  if (row.status === 'failed') {
    return {
      ...base,
      status: 'failed',
      error: JSON.parse(row.error ?? '{"code":-32603,"message":"Unknown worker error"}')
    }
  }
  if (row.status === 'cancelled') return { ...base, status: 'cancelled' }
  if (row.status === 'input_required') return { ...base, status: 'input_required', inputRequests }
  return { ...base, status: 'working' }
}
