import { createInvalidTaskParamsError } from './errors.js'
import type {
  CancelTaskParams,
  GetTaskParams,
  TaskInputResponses,
  UpdateTaskParams
} from './types.js'

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function parseTaskId(params: unknown): string {
  if (!isRecord(params) || typeof params.taskId !== 'string' || params.taskId.length === 0) {
    throw createInvalidTaskParamsError('Missing task ID')
  }
  return params.taskId
}

export function validateGetTaskParams(params: unknown): GetTaskParams {
  return { taskId: parseTaskId(params) }
}

export function validateCancelTaskParams(params: unknown): CancelTaskParams {
  return { taskId: parseTaskId(params) }
}

export function validateUpdateTaskParams(params: unknown): UpdateTaskParams {
  const taskId = parseTaskId(params)
  if (!isRecord(params) || !isRecord(params.inputResponses)) {
    throw createInvalidTaskParamsError('Missing task input responses')
  }

  const entries: Array<[string, TaskInputResponses[string]]> = []
  for (const [key, response] of Object.entries(params.inputResponses)) {
    if (key.length === 0 || !isRecord(response)) {
      throw createInvalidTaskParamsError('Task input responses must be keyed objects')
    }
    entries.push([key, response as unknown as TaskInputResponses[string]])
  }

  return { taskId, inputResponses: Object.fromEntries(entries) }
}

export function hasTasksCapability(meta: Record<string, unknown> | undefined): boolean {
  if (!meta) return false
  const capabilities = meta['io.modelcontextprotocol/clientCapabilities']
  if (!isRecord(capabilities) || !isRecord(capabilities.extensions)) return false
  return isRecord(capabilities.extensions['io.modelcontextprotocol/tasks'])
}
