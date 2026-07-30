import type { TasksVersionInput } from './types.js'
import { TASKS_EXTENSION_ID, type TaskCapabilityErrorData } from './types.js'
import { taskCapabilityErrorCode } from './version.js'

export class TaskProtocolError extends Error {
  readonly code: number
  readonly data?: unknown

  constructor(code: number, message: string, data?: unknown) {
    super(message)
    this.name = 'TaskProtocolError'
    this.code = code
    this.data = data
  }
}

export function createMissingTaskCapabilityError(
  version: TasksVersionInput = 'current'
): TaskProtocolError {
  const data: TaskCapabilityErrorData = {
    requiredCapabilities: {
      extensions: {
        [TASKS_EXTENSION_ID]: {}
      }
    }
  }

  return new TaskProtocolError(
    taskCapabilityErrorCode(version),
    'Missing required client capability',
    data
  )
}

export function createInvalidTaskParamsError(message: string): TaskProtocolError {
  return new TaskProtocolError(-32602, message)
}
