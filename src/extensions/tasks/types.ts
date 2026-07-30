export const TASKS_EXTENSION_ID = 'io.modelcontextprotocol/tasks' as const

export type TasksVersion = '2026-07-28' | 'draft'
export type TasksVersionInput = TasksVersion | 'current'

/**
 * Internal policy for whether a registered operation may execute as a task.
 * This is intentionally not serialized in 2026-era `tools/list` responses.
 */
export type TaskExecutionMode = 'synchronous' | 'optional' | 'required'

export type TaskStatus = 'working' | 'input_required' | 'completed' | 'failed' | 'cancelled'

export interface Task {
  taskId: string
  status: TaskStatus
  statusMessage?: string
  createdAt: string
  lastUpdatedAt: string
  ttlMs: number | null
  pollIntervalMs?: number
}

export interface TaskElicitationInputRequest {
  method: 'elicitation/create'
  params?: Record<string, unknown>
}

export interface TaskSamplingInputRequest {
  method: 'sampling/createMessage'
  params?: Record<string, unknown>
}

export interface TaskRootsInputRequest {
  method: 'roots/list'
  params?: never
}

export type TaskInputRequest =
  | TaskElicitationInputRequest
  | TaskSamplingInputRequest
  | TaskRootsInputRequest

export interface TaskInputResponse {
  resultType?: string
  [key: string]: unknown
}

export interface TaskInputRequests {
  [key: string]: TaskInputRequest
}

export interface TaskInputResponses {
  [key: string]: TaskInputResponse
}

/**
 * Serial-safe execution descriptor handed to the durable task provider.
 * The actual invocation function stays on an explicit ephemeral scheduler.
 */
export interface TaskExecutionDescriptor {
  method: string
  params: Record<string, unknown>
}

export interface WorkingTask extends Task {
  status: 'working'
}

export interface InputRequiredTask extends Task {
  status: 'input_required'
  inputRequests: TaskInputRequests
}

export interface CompletedTask<TResult extends Record<string, unknown> = Record<string, unknown>>
  extends Task {
  status: 'completed'
  result: TResult
}

export interface TaskJsonRpcError extends Record<string, unknown> {
  code: number
  message: string
  data?: unknown
}

export interface FailedTask extends Task {
  status: 'failed'
  error: TaskJsonRpcError
}

export interface CancelledTask extends Task {
  status: 'cancelled'
}

export type DetailedTask<TResult extends Record<string, unknown> = Record<string, unknown>> =
  | WorkingTask
  | InputRequiredTask
  | CompletedTask<TResult>
  | FailedTask
  | CancelledTask

/** Final SEP-2663 task record selected by `2026-07-28` and `current`. */
export type Task20260728<TResult extends Record<string, unknown> = Record<string, unknown>> =
  DetailedTask<TResult>

/** Pinned ext-tasks draft record; its capability error code differs from the final codec. */
export type TaskDraft<TResult extends Record<string, unknown> = Record<string, unknown>> =
  DetailedTask<TResult>

export type CreateTaskResult<TResult extends Record<string, unknown> = Record<string, unknown>> =
  DetailedTask<TResult> & { resultType: 'task' }
export type GetTaskResult<TResult extends Record<string, unknown> = Record<string, unknown>> =
  DetailedTask<TResult> & { resultType: 'complete' }
export interface UpdateTaskResult {
  resultType: 'complete'
}
export interface CancelTaskResult {
  resultType: 'complete'
}

export interface GetTaskParams {
  taskId: string
}

export interface UpdateTaskParams extends GetTaskParams {
  inputResponses: TaskInputResponses
}

export type CancelTaskParams = GetTaskParams

export type TaskMethod = 'tasks/get' | 'tasks/update' | 'tasks/cancel'
export type TaskMethodResult = GetTaskResult | UpdateTaskResult | CancelTaskResult

export interface TaskRequestContext {
  request: Request
  signal?: AbortSignal
  meta?: Record<string, unknown>
  principalKey?: string
}

export type TaskInvoke<TResult extends Record<string, unknown> = Record<string, unknown>> = (
  signal?: AbortSignal
) => Promise<TResult>

export interface TaskExecutionScheduler<
  TResult extends Record<string, unknown> = Record<string, unknown>
> {
  /**
   * Ephemeral invocation handle. Providers MUST NOT persist this object; the
   * structured-clone-safe descriptor is supplied separately in `request`.
   */
  invoke: TaskInvoke<TResult>
}

/**
 * Adapter-side execution state. This shape never crosses the durable provider
 * boundary; `TaskDurableCreateRequest` is the persistent representation.
 */
export interface TaskExecution<TResult extends Record<string, unknown> = Record<string, unknown>> {
  method: string
  params: Record<string, unknown>
  invoke: TaskInvoke<TResult>
}

export interface TaskCreateRequest<
  TResult extends Record<string, unknown> = Record<string, unknown>
> {
  execution: TaskExecution<TResult>
  mode: Exclude<TaskExecutionMode, 'synchronous'>
  ttlMs?: number | null
  pollIntervalMs?: number
}

export interface TaskDurableCreateRequest {
  execution: TaskExecutionDescriptor
  mode: Exclude<TaskExecutionMode, 'synchronous'>
  ttlMs?: number | null
  pollIntervalMs?: number
}

export interface TaskProviderContext {
  version: TasksVersion
  meta?: Readonly<Record<string, unknown>>
  principalKey?: string
}

export interface TaskSubscription {
  /** The subset of requested task IDs accepted by the provider. Defaults to all requested IDs. */
  acceptedTaskIds?: readonly string[]
  close(): void | Promise<void>
  /** Resolves when the provider intentionally ends the stream gracefully. */
  done?: Promise<void>
}

export type TaskStatusListener = (task: DetailedTask) => void | Promise<void>

/**
 * Durable backing service for tasks. `create` MUST resolve only after the task
 * is readable through `get`, including across later stateless HTTP requests.
 * It MUST assign cryptographically unguessable IDs and enforce `principalKey`
 * ownership on every operation when that key is present.
 * `request` and `context` are safe to persist. `scheduler` is an explicitly
 * ephemeral handle and MUST NOT be serialized, retained, or sent to a worker.
 * Implementations may use a database, queue/job service, or other shared store.
 */
export interface TaskProvider {
  create(
    request: TaskDurableCreateRequest,
    context: TaskProviderContext,
    scheduler: TaskExecutionScheduler
  ): Promise<DetailedTask>
  get(taskId: string, context: TaskProviderContext): Promise<DetailedTask | undefined>
  update(
    taskId: string,
    inputResponses: TaskInputResponses,
    context: TaskProviderContext
  ): Promise<boolean | undefined>
  /**
   * Durably records a server-to-client MRTR request. The provider MUST enforce
   * that `key` is never reused for a task, even after its response is received.
   */
  requestInput(
    taskId: string,
    key: string,
    request: TaskInputRequest,
    context: TaskProviderContext
  ): Promise<boolean | undefined>
  cancel(taskId: string, context: TaskProviderContext): Promise<boolean | undefined>
  listen?(
    taskIds: readonly string[],
    listener: TaskStatusListener,
    context: TaskProviderContext
  ): Promise<TaskSubscription | undefined> | TaskSubscription | undefined
}

export interface TaskControllerOptions {
  provider: TaskProvider
  version?: TasksVersionInput
}

export interface TaskDispatchRequest {
  method: TaskMethod
  params: unknown
  context: TaskRequestContext
}

export interface TaskCapabilityErrorData {
  requiredCapabilities: {
    extensions: {
      [TASKS_EXTENSION_ID]: Record<string, never>
    }
  }
}
