import type { Database } from 'bun:sqlite'
import type {
  DetailedTask,
  TaskInputRequest,
  TaskInputResponse,
  TaskProviderContext
} from '@mwillbanks/elysia-mcp-adapter'

export const terminalStatuses = new Set<DetailedTask['status']>([
  'completed',
  'failed',
  'cancelled'
])

export function principal(context: TaskProviderContext): string {
  return context.principalKey ?? ''
}

export function getInputResponse(
  database: Database,
  taskId: string,
  key: string,
  context: TaskProviderContext
): TaskInputResponse | undefined {
  const row = database
    .query<{ response: string }, [string, string, string]>(
      `SELECT r.response
       FROM task_input_requests r JOIN tasks t ON r.task_id = t.task_id
       WHERE r.task_id = ? AND r.request_key = ? AND t.principal_key = ?
         AND r.response IS NOT NULL`
    )
    .get(taskId, key, principal(context))
  return row ? JSON.parse(row.response) : undefined
}

export async function setStatusMessage(
  database: Database,
  taskId: string,
  message: string,
  context: TaskProviderContext
): Promise<boolean> {
  const result = database
    .query(
      `UPDATE tasks SET status_message = ?, updated_at = ?
       WHERE task_id = ? AND principal_key = ?
         AND status IN ('working', 'input_required')`
    )
    .run(message, new Date().toISOString(), taskId, principal(context))
  return result.changes === 1
}

export async function recordTaskInput(
  database: Database,
  taskId: string,
  key: string,
  request: TaskInputRequest,
  context: TaskProviderContext
): Promise<boolean> {
  const transaction = database.transaction((): boolean => {
    const task = database
      .query<{ status: DetailedTask['status'] }, [string, string]>(
        'SELECT status FROM tasks WHERE task_id = ? AND principal_key = ?'
      )
      .get(taskId, principal(context))
    if (!task || terminalStatuses.has(task.status)) return false
    const inserted = database
      .query(
        `INSERT OR IGNORE INTO task_input_requests (task_id, request_key, request)
         VALUES (?, ?, ?)`
      )
      .run(taskId, key, JSON.stringify(request))
    if (inserted.changes !== 1) return false
    const transitioned = database
      .query(
        `UPDATE tasks SET status = 'input_required', updated_at = ?
         WHERE task_id = ? AND principal_key = ?
           AND status IN ('working', 'input_required')`
      )
      .run(new Date().toISOString(), taskId, principal(context))
    return transitioned.changes === 1
  })
  return transaction.immediate()
}
