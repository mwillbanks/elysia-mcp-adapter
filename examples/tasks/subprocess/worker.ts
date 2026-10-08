import { Database } from 'bun:sqlite'
import { mcp } from '@mwillbanks/elysia-mcp-adapter'
import { Elysia, t } from 'elysia'

interface StoredTask {
  descriptor: string
  status: string
}

const [databasePath, taskId] = process.argv.slice(2)
if (!databasePath || !taskId) throw new Error('Expected database path and task ID')
const resolvedDatabasePath = databasePath
const resolvedTaskId = taskId

const database = new Database(resolvedDatabasePath, { readwrite: true, create: false })
database.exec('PRAGMA busy_timeout = 5000')

function update(status: string, value: Record<string, unknown>): void {
  database
    .query(
      `UPDATE tasks SET status = ?, result = ?, error = NULL, child_pid = ?, updated_at = ?
       WHERE task_id = ? AND status = 'working'`
    )
    .run(status, JSON.stringify(value), process.pid, new Date().toISOString(), resolvedTaskId)
}

try {
  const stored = database
    .query<StoredTask, [string]>('SELECT descriptor, status FROM tasks WHERE task_id = ?')
    .get(resolvedTaskId)
  if (stored?.status !== 'working') process.exit(0)

  const descriptor = JSON.parse(stored.descriptor) as {
    method: string
    params: { name?: unknown; arguments?: unknown; _meta?: unknown }
  }
  if (descriptor.method !== 'tools/call' || descriptor.params.name !== 'tasks.run') {
    throw new Error('Unsupported durable execution descriptor')
  }
  const descriptorMeta =
    typeof descriptor.params._meta === 'object' && descriptor.params._meta !== null
      ? descriptor.params._meta
      : {}
  const workerParams = {
    ...descriptor.params,
    _meta: {
      ...descriptorMeta,
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientInfo': { name: 'subprocess-worker', version: '1.0.0' },
      'io.modelcontextprotocol/clientCapabilities': {}
    }
  }

  const app = new Elysia()
    .use(
      mcp({
        server: { name: 'subprocess-task-worker', version: '1.0.0' }
      })
    )
    .post(
      '/tasks/run',
      async ({ body, set }) => {
        await Bun.sleep(body.delayMs)
        if (body.value === 'tool-error') {
          set.status = 422
          return { message: 'Expected tool-level failure' }
        }
        return { childPid: process.pid, value: body.value }
      },
      {
        body: t.Object({ value: t.String(), delayMs: t.Number({ minimum: 0 }) }),
        detail: { operationId: 'tasks.run' }
      }
    )

  const response = await app.handle(
    new Request('http://worker.local/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2026-07-28',
        'mcp-method': descriptor.method,
        'mcp-name': 'tasks.run'
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: resolvedTaskId,
        method: descriptor.method,
        params: workerParams
      })
    })
  )
  const payload = (await response.json()) as {
    result?: Record<string, unknown>
    error?: { code?: number; message?: string; data?: unknown }
  }
  if (!response.ok || payload.error || !payload.result) {
    const failure = new Error(
      payload.error?.message ?? `Worker MCP call failed with ${response.status}`
    )
    Object.assign(failure, {
      code: Number.isInteger(payload.error?.code) ? payload.error?.code : -32603,
      data: payload.error?.data
    })
    throw failure
  }
  update('completed', payload.result)
} catch (error) {
  database
    .query(
      `UPDATE tasks SET status = 'failed', error = ?, updated_at = ?
       WHERE task_id = ? AND status = 'working'`
    )
    .run(
      JSON.stringify({
        code:
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          Number.isInteger(error.code)
            ? error.code
            : -32603,
        message: error instanceof Error ? error.message : String(error)
      }),
      new Date().toISOString(),
      resolvedTaskId
    )
  process.exitCode = 1
} finally {
  database.close()
}
