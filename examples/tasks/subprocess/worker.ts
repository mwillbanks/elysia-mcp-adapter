import { Database } from 'bun:sqlite'
import type { TaskExecutionDescriptor, TaskProviderContext } from '@mwillbanks/elysia-mcp-adapter'
import { createMcpTaskExecutionContext, mcp } from '@mwillbanks/elysia-mcp-adapter'
import { Elysia, t } from 'elysia'
import { approvalKey, approvalRequest, requiresApproval } from './approval.js'
import { getInputResponse, recordTaskInput, setStatusMessage } from './input-store.js'

interface StoredTask {
  descriptor: string
  principal_key: string
  status: string
}

const [databasePath, taskId] = process.argv.slice(2)
if (!databasePath || !taskId) throw new Error('Expected database path and task ID')
const resolvedDatabasePath = databasePath
const resolvedTaskId = taskId

const database = new Database(resolvedDatabasePath, { readwrite: true, create: false })
database.exec('PRAGMA busy_timeout = 5000')
database.exec('PRAGMA foreign_keys = ON')

function update(status: string, value: Record<string, unknown>): void {
  database
    .query(
      `UPDATE tasks SET status = ?, result = ?, error = NULL, child_pid = ?, updated_at = ?
       WHERE task_id = ? AND status = 'working'`
    )
    .run(status, JSON.stringify(value), process.pid, new Date().toISOString(), resolvedTaskId)
}

async function resolveApproval(
  descriptor: TaskExecutionDescriptor,
  principalKey: string
): Promise<boolean | undefined> {
  if (!requiresApproval(descriptor.params)) return true
  const metadata = descriptor.params._meta
  const context: TaskProviderContext = {
    version: '2026-07-28',
    principalKey,
    meta:
      typeof metadata === 'object' && metadata !== null
        ? (metadata as Record<string, unknown>)
        : undefined
  }
  const execution = createMcpTaskExecutionContext({
    taskId: resolvedTaskId,
    context,
    provider: {
      requestInput: (...args) => recordTaskInput(database, ...args),
      setStatusMessage: (...args) => setStatusMessage(database, ...args)
    }
  })
  const response = getInputResponse(database, resolvedTaskId, approvalKey, context)
  if (response) {
    await execution.notify.status('Approval answered')
    const answer = response.content
    return (
      response.action === 'accept' &&
      typeof answer === 'object' &&
      answer !== null &&
      'approved' in answer &&
      answer.approved === true
    )
  }

  await execution.notify.status('Waiting for approval')
  await execution.input.request(approvalKey, approvalRequest)
  return undefined
}

async function run(): Promise<void> {
  const stored = database
    .query<StoredTask, [string]>(
      'SELECT descriptor, principal_key, status FROM tasks WHERE task_id = ?'
    )
    .get(resolvedTaskId)
  if (stored?.status !== 'working') return

  const descriptor = JSON.parse(stored.descriptor) as TaskExecutionDescriptor
  if (descriptor.method !== 'tools/call' || descriptor.params.name !== 'tasks.run') {
    throw new Error('Unsupported durable execution descriptor')
  }
  const approved = await resolveApproval(descriptor, stored.principal_key)
  if (approved === undefined) return
  update('completed', await invokeWorkerTool(descriptor, approved))
}

async function invokeWorkerTool(
  descriptor: TaskExecutionDescriptor,
  approved: boolean
): Promise<Record<string, unknown>> {
  const workerParams = {
    name: descriptor.params.name,
    arguments: descriptor.params.arguments,
    _meta: {
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
        if (!approved) {
          set.status = 422
          return { message: 'Task approval declined' }
        }
        await Bun.sleep(body.delayMs)
        if (body.value === 'tool-error') {
          set.status = 422
          return { message: 'Expected tool-level failure' }
        }
        return { childPid: process.pid, value: body.value }
      },
      {
        body: t.Object({
          value: t.String(),
          delayMs: t.Number({ minimum: 0 }),
          requireApproval: t.Optional(t.Boolean())
        }),
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
  return readWorkerResult(response)
}

async function readWorkerResult(response: Response): Promise<Record<string, unknown>> {
  const payload = (await response.json()) as {
    result?: Record<string, unknown>
    error?: { code?: number; message?: string; data?: unknown }
  }
  if (!response.ok || payload.error || !payload.result) {
    throw workerFailure(response.status, payload.error)
  }
  return payload.result
}

function workerFailure(
  status: number,
  error?: { code?: number; message?: string; data?: unknown }
) {
  return Object.assign(new Error(error?.message ?? `Worker MCP call failed with ${status}`), {
    code: Number.isInteger(error?.code) ? error?.code : -32603,
    data: error?.data
  })
}

try {
  await run()
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
