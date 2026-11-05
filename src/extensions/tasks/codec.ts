import { isRecord } from '../../internal.js'
import {
  isMcpElicitationResult,
  isMcpRootsResult,
  isMcpSamplingResult
} from '../../schema/content.js'
import { isValidUri } from '../../schema/validate.js'
import { validateInputAnswer } from '../../transport/input.js'
import type {
  DetailedTask,
  TaskCreateRequest,
  TaskDefinedInputResponse,
  TaskDurableCreateRequest,
  TaskExecutionDescriptor,
  TaskExecutionScheduler,
  TaskInputRequest,
  TaskProviderContext,
  TaskStatus,
  TasksVersion
} from './types.js'

const TASK_STATUSES: readonly TaskStatus[] = [
  'working',
  'input_required',
  'completed',
  'failed',
  'cancelled'
]
const TASK_INPUT_METHODS = new Set(['elicitation/create', 'sampling/createMessage', 'roots/list'])

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
    async invoke(signal, taskExecution) {
      const result = await invoke(signal ?? taskExecution?.signal, taskExecution)
      assertCompletedResult(result, 'Task execution result')
      return result
    }
  }
}

export function assertTaskRecord(value: unknown, label = 'task'): asserts value is DetailedTask {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`)
  assertTaskBase(value, label)
  assertTaskStatusPayload(value, label)
}

/** Validates a response against the outstanding request it satisfies. */
export function assertTaskInputResponse(
  request: TaskInputRequest,
  response: unknown,
  label?: string,
  version?: Exclude<TasksVersion, 'draft'>
): asserts response is TaskDefinedInputResponse
export function assertTaskInputResponse(
  request: TaskInputRequest,
  response: unknown,
  label: string | undefined,
  version: 'draft'
): asserts response is import('./types.js').TaskInputResponse
export function assertTaskInputResponse(
  request: TaskInputRequest,
  response: unknown,
  label: string | undefined,
  version: TasksVersion
): asserts response is TaskDefinedInputResponse | import('./types.js').TaskInputResponse
export function assertTaskInputResponse(
  request: TaskInputRequest,
  response: unknown,
  label = 'task input response',
  version: TasksVersion = '2026-07-28'
): asserts response is TaskDefinedInputResponse | import('./types.js').TaskInputResponse {
  if (!isRecord(response)) throw new TypeError(`${label} must be an object`)
  if (version === 'draft') return
  if (request.method === 'elicitation/create') {
    if (!isMcpElicitationResult(response))
      throw new TypeError(`${label}.action or content is invalid`)
    assertElicitationContent(request, response, label)
    return
  }
  if (request.method === 'roots/list') {
    if (!isMcpRootsResult(response)) throw new TypeError(`${label}.roots must contain file URIs`)
    return
  }
  if (!isMcpSamplingResult(response)) {
    throw new TypeError(`${label}.content must contain valid MCP sampling content`)
  }
}

function assertElicitationContent(
  request: Extract<TaskInputRequest, { method: 'elicitation/create' }>,
  response: unknown,
  label: string
): void {
  const params = request.params
  if (!params) return
  const message = typeof params.message === 'string' ? params.message : ''
  if (params.mode === 'url') {
    if (!isValidUri(params.url)) throw new TypeError(`${label} requires an elicitation URL`)
    validateInputAnswer(
      label,
      { method: request.method, params: { mode: 'url', message, url: params.url } },
      response
    )
    return
  }
  const requestedSchema = taskFormSchema(params, label)
  if (requestedSchema) {
    validateInputAnswer(
      label,
      { method: request.method, params: { message, requestedSchema } },
      response
    )
  }
}

function taskFormSchema({ mode, requestedSchema }: Record<string, unknown>, label: string) {
  if (mode !== undefined && mode !== 'form') {
    throw new TypeError(`${label} has an invalid elicitation mode`)
  }
  // Mode-free legacy requests may omit the schema. An explicitly declared form cannot.
  if (mode === undefined && requestedSchema === undefined) return undefined
  if (!isRecord(requestedSchema)) throw new TypeError(`${label} requires an elicitation schema`)
  return requestedSchema
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
  const validators: Partial<Record<TaskStatus, () => void>> = {
    working: () => assertNoStatusPayload(value, ['result', 'error', 'inputRequests']),
    input_required: () => assertInputRequiredPayload(value, label),
    completed: () => assertCompletedPayload(value, label),
    failed: () => assertFailedPayload(value, label),
    cancelled: () => assertNoStatusPayload(value, ['result', 'error', 'inputRequests'])
  }
  validators[value.status as TaskStatus]?.()
}

function assertInputRequiredPayload(value: Record<string, unknown>, label: string): void {
  if (!isRecord(value.inputRequests))
    throw new TypeError(`${label}.inputRequests must be an object`)
  assertTaskInputRequests(value.inputRequests, label)
  assertNoStatusPayload(value, ['result', 'error'])
}

function assertCompletedPayload(value: Record<string, unknown>, label: string): void {
  if (!isRecord(value.result)) throw new TypeError(`${label}.result must be an object`)
  assertCompletedResult(value.result, `${label}.result`)
  assertNoStatusPayload(value, ['error', 'inputRequests'])
}

function assertCompletedResult(result: Record<string, unknown>, label: string): void {
  if (result.resultType === 'input_required') {
    throw new TypeError(`${label} cannot contain MRTR input; use the task input API`)
  }
}

function assertFailedPayload(value: Record<string, unknown>, label: string): void {
  if (!isRecord(value.error)) throw new TypeError(`${label}.error must be an object`)
  if (!Number.isInteger(value.error.code) || typeof value.error.message !== 'string') {
    throw new TypeError(`${label}.error must include code and message`)
  }
  assertNoStatusPayload(value, ['result', 'inputRequests'])
}

function assertTaskInputRequests(requests: Record<string, unknown>, label: string): void {
  for (const [key, request] of Object.entries(requests)) {
    assertTaskInputRequest(request, label, key)
  }
}

function assertTaskInputRequest(request: unknown, label: string, key: string): void {
  if (!isRecord(request)) throw new TypeError(`${label}.inputRequests.${key} must be an object`)
  if (typeof request.method !== 'string' || !TASK_INPUT_METHODS.has(request.method)) {
    throw new TypeError(`${label}.inputRequests.${key}.method is invalid`)
  }
  if (request.method === 'roots/list' && request.params !== undefined) {
    throw new TypeError(`${label}.inputRequests.${key}.params is not valid for roots/list`)
  }
  if (
    request.method !== 'roots/list' &&
    request.params !== undefined &&
    !isRecord(request.params)
  ) {
    throw new TypeError(`${label}.inputRequests.${key}.params must be an object`)
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
