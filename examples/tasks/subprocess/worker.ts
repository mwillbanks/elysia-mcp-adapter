import { Database } from 'bun:sqlite'
import { Elysia, t } from 'elysia'
import { mcp } from '../../../src/index.js'

interface StoredTask {
  descriptor: string
  status: string
}

const [databasePath, taskId] = process.argv.slice(2)
if (!databasePath || !taskId) throw new Error('Expected database path and task ID')
const resolvedDatabasePath = databasePath
const resolvedTaskId = taskId

const database = new Database(resolvedDatabasePath, { readwrite: true, create: false })

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
      async ({ body }) => {
        await Bun.sleep(body.delayMs)
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
    result?: { isError?: boolean; structuredContent?: Record<string, unknown> }
    error?: { message?: string }
  }
  if (
    !response.ok ||
    payload.error ||
    payload.result?.isError ||
    !payload.result?.structuredContent
  ) {
    const structuredMessage = payload.result?.structuredContent?.message
    throw new Error(
      payload.error?.message ??
        (typeof structuredMessage === 'string' ? structuredMessage : undefined) ??
        `Worker MCP call failed with ${response.status}`
    )
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
        code: -32603,
        message: error instanceof Error ? error.message : String(error)
      }),
      new Date().toISOString(),
      resolvedTaskId
    )
  process.exitCode = 1
} finally {
  database.close()
}
