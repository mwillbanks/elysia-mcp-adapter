import { isRecord } from '../../internal.js'
import { assertInputRequestCapabilities } from '../../transport/input-request-validation.js'
import type { McpInputRequest } from '../../types.js'
import { toDurableTaskProviderContext } from './codec.js'
import { createInvalidTaskParamsError } from './errors.js'
import type { TaskInputRequest, TaskProvider, TaskProviderContext } from './types.js'

export function assertOriginatingTaskInput(
  key: string,
  request: TaskInputRequest | McpInputRequest,
  meta: TaskProviderContext['meta']
): void {
  if (typeof key !== 'string' || key.length === 0) {
    throw createInvalidTaskParamsError('Task input request key is required')
  }
  const advertised = meta?.['io.modelcontextprotocol/clientCapabilities']
  assertInputRequestCapabilities({ [key]: request }, isRecord(advertised) ? advertised : undefined)
}

/** Reports durable status and requests input for one owned task. */
export interface McpTaskExecutionContext {
  readonly taskId: string
  readonly signal?: AbortSignal
  readonly notify: {
    /** Persist a status message for task polling and subscriptions. */
    status(message: string): Promise<void>
  }
  readonly input: {
    /** Persist an input request with a key unique for the lifetime of the task. */
    request(key: string, request: McpInputRequest): Promise<void>
  }
}

/** Data and persistence callbacks used to bind a worker to its task. */
export interface McpTaskExecutionContextOptions {
  taskId: string
  /** The provider context retained from task creation, including the originating capabilities. */
  context: TaskProviderContext
  /** Callbacks must enforce ownership and persist changes before resolving. */
  provider: Pick<TaskProvider, 'requestInput' | 'setStatusMessage'>
  signal?: AbortSignal
}

/** Bind a worker to an owned task. Recreate this context from durable data after a restart. */
export function createMcpTaskExecutionContext({
  taskId,
  context,
  provider,
  signal
}: McpTaskExecutionContextOptions): McpTaskExecutionContext {
  if (typeof taskId !== 'string' || taskId.length === 0) {
    throw createInvalidTaskParamsError('Task ID is required')
  }
  const owner = toDurableTaskProviderContext(context)

  return Object.freeze({
    taskId,
    signal,
    notify: Object.freeze({
      async status(message: string): Promise<void> {
        signal?.throwIfAborted()
        if (typeof message !== 'string') throw new TypeError('Task status message must be a string')
        if (!provider.setStatusMessage) {
          throw new TypeError('Task provider does not support updating the status message')
        }
        if ((await provider.setStatusMessage(taskId, message, owner)) === false) {
          throw createInvalidTaskParamsError('Task is unavailable for status updates')
        }
      }
    }),
    input: Object.freeze({
      async request(key: string, request: McpInputRequest): Promise<void> {
        signal?.throwIfAborted()
        assertOriginatingTaskInput(key, request, owner.meta)
        const input = request.method === 'roots/list' ? { method: request.method } : request
        if ((await provider.requestInput(taskId, key, input, owner)) === false) {
          throw createInvalidTaskParamsError(
            'Task is unavailable or the input request key was used'
          )
        }
      }
    })
  })
}
