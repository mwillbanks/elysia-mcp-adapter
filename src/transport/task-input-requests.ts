import type {
  CreateTaskResult,
  DetailedTask,
  TaskInputRequests
} from '../extensions/tasks/index.js'
import { isRecord } from '../internal.js'

const taskCreationResults = new WeakSet<object>()

export function markTaskCreationResult(result: CreateTaskResult): CreateTaskResult {
  taskCreationResults.add(result)
  return result
}

/** Read pending inputs from a snapshot already validated by the Tasks controller. */
export function pendingTaskInputRequests(task: DetailedTask): TaskInputRequests | undefined {
  return task.status === 'input_required' ? task.inputRequests : undefined
}

/** Call on the dispatch result before serialization copies the envelope. */
export function taskResultInputRequests(
  method: string,
  result: Record<string, unknown>
): Record<string, unknown> | undefined {
  if (method !== 'tasks/get' && !taskCreationResults.has(result)) return undefined
  if (result.status !== 'input_required' || !isRecord(result.inputRequests)) return undefined
  return result.inputRequests
}
