import { isRecord } from '../internal.js'
import type { JsonRpcRequest } from '../types.js'

const NAME_METHODS = new Set(['tools/call', 'prompts/get'])
const URI_METHODS = new Set(['resources/read', 'resources/directory/read', 'skills/get'])
const TASK_METHODS = new Set(['tasks/get', 'tasks/update', 'tasks/cancel'])

export function requestTargetName(payload: JsonRpcRequest): string | undefined {
  const params = isRecord(payload.params) ? payload.params : {}
  const field = targetField(payload.method)
  const value = field ? params[field] : undefined
  return typeof value === 'string' ? value : undefined
}

function targetField(method: unknown): 'name' | 'taskId' | 'uri' | undefined {
  if (typeof method !== 'string') return undefined
  if (NAME_METHODS.has(method)) return 'name'
  if (URI_METHODS.has(method)) return 'uri'
  if (TASK_METHODS.has(method)) return 'taskId'
  return undefined
}
