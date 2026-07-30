import { isRecord } from '../../internal.js'
import type {
  DetailedTask,
  TaskCreateRequest,
  TaskDurableCreateRequest,
  TaskExecutionDescriptor,
  TaskExecutionScheduler,
  TaskProviderContext,
  TaskStatus
} from './types.js'

const TASK_STATUSES: readonly TaskStatus[] = [
  'working',
  'input_required',
  'completed',
  'failed',
  'cancelled'
]

function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === 'string' && TASK_STATUSES.includes(value as TaskStatus)
}

function assertTaskExecutionDescriptor(
  value: unknown,
  label = 'task execution'
): asserts value is TaskExecutionDescriptor {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`)
  if (typeof value.method !== 'string' || value.method.length === 0) {
    throw new TypeError(`${label}.method must be a non-empty string`)
  }
  if (!isRecord(value.params)) {
    throw new TypeError(`${label}.params must be an object`)
  }
}

export function toDurableTaskCreateRequest(request: TaskCreateRequest): TaskDurableCreateRequest {
  assertTaskCreateRequest(request)
  return {
    execution: {
      method: request.execution.method,
      params: cloneRecord(request.execution.params)
    },
    mode: request.mode,
    ttlMs: request.ttlMs,
    pollIntervalMs: request.pollIntervalMs
  }
}

export function toDurableTaskProviderContext(
  context: TaskProviderContext
): Readonly<TaskProviderContext> {
  return Object.freeze({
    version: context.version,
    meta: context.meta ? Object.freeze(cloneRecord(context.meta)) : undefined,
    principalKey: context.principalKey
  })
}

export function buildTaskExecutionScheduler<TResult extends Record<string, unknown>>(
  invoke: TaskExecutionScheduler<TResult>['invoke']
): TaskExecutionScheduler<TResult> {
  return {
    invoke: (signal?: AbortSignal) => invoke(signal)
  }
}

export function assertTaskRecord(value: unknown, label = 'task'): asserts value is DetailedTask {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`)
  assertTaskBase(value, label)
  assertTaskStatusPayload(value, label)
}

function assertTaskBase(value: Record<string, unknown>, label: string): void {
  assertTaskIdentity(value, label)
  assertTaskTiming(value, label)
}

function assertTaskIdentity(value: Record<string, unknown>, label: string): void {
  if (typeof value.taskId !== 'string' || value.taskId.length === 0) {
    throw new TypeError(`${label}.taskId must be a non-empty string`)
  }
  if (!isTaskStatus(value.status)) {
    throw new TypeError(`${label}.status must be a valid task status`)
  }
  if (value.statusMessage !== undefined && typeof value.statusMessage !== 'string') {
    throw new TypeError(`${label}.statusMessage must be a string when present`)
  }
}

function assertTaskTiming(value: Record<string, unknown>, label: string): void {
  if (!isIsoTimestamp(value.createdAt)) {
    throw new TypeError(`${label}.createdAt must be an ISO string`)
  }
  if (!isIsoTimestamp(value.lastUpdatedAt)) {
    throw new TypeError(`${label}.lastUpdatedAt must be an ISO string`)
  }
  if (value.ttlMs !== null && (!Number.isSafeInteger(value.ttlMs) || (value.ttlMs as number) < 0)) {
    throw new TypeError(`${label}.ttlMs must be a non-negative integer or null`)
  }
  if (
    value.pollIntervalMs !== undefined &&
    (!Number.isSafeInteger(value.pollIntervalMs) || (value.pollIntervalMs as number) <= 0)
  ) {
    throw new TypeError(`${label}.pollIntervalMs must be a positive integer when present`)
  }
}

function assertTaskStatusPayload(value: Record<string, unknown>, label: string): void {
  switch (value.status) {
    case 'working':
      assertNoStatusPayload(value, ['result', 'error', 'inputRequests'])
      return
    case 'input_required':
      if (!isRecord(value.inputRequests)) {
        throw new TypeError(`${label}.inputRequests must be an object`)
      }
      assertNoStatusPayload(value, ['result', 'error'])
      return
    case 'completed':
      if (!isRecord(value.result)) {
        throw new TypeError(`${label}.result must be an object`)
      }
      assertNoStatusPayload(value, ['error', 'inputRequests'])
      return
    case 'failed':
      if (!isRecord(value.error)) {
        throw new TypeError(`${label}.error must be an object`)
      }
      if (
        !Number.isInteger((value.error as Record<string, unknown>).code) ||
        typeof (value.error as Record<string, unknown>).message !== 'string'
      ) {
        throw new TypeError(`${label}.error must include code and message`)
      }
      assertNoStatusPayload(value, ['result', 'inputRequests'])
      return
    case 'cancelled':
      assertNoStatusPayload(value, ['result', 'error', 'inputRequests'])
      return
  }
}

export function assertTaskCreateRequest(value: unknown): asserts value is TaskCreateRequest {
  if (!isRecord(value)) throw new TypeError('Task create request must be an object')
  assertTaskExecutionDescriptor(value.execution, 'Task create execution')
  if (value.mode !== 'optional' && value.mode !== 'required') {
    throw new TypeError('Task create request mode must be optional or required')
  }
  if (
    value.ttlMs !== undefined &&
    value.ttlMs !== null &&
    (!Number.isSafeInteger(value.ttlMs) || (value.ttlMs as number) < 0)
  ) {
    throw new TypeError('Task create request ttlMs must be a non-negative integer when present')
  }
  if (
    value.pollIntervalMs !== undefined &&
    (!Number.isSafeInteger(value.pollIntervalMs) || (value.pollIntervalMs as number) <= 0)
  ) {
    throw new TypeError('Task create request pollIntervalMs must be positive when present')
  }
}

function assertNoStatusPayload(value: Record<string, unknown>, keys: readonly string[]): void {
  for (const key of keys) {
    if (key in value) {
      throw new TypeError(`Task ${String(value.status)} records cannot include ${key}`)
    }
  }
}

function cloneRecord(value: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return typeof structuredClone === 'function' ? structuredClone(value) : { ...value }
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) && /^\d{4}-\d{2}-\d{2}T/iu.test(value)
}
