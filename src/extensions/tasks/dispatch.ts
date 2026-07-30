import type { TaskController } from './controller.js'
import type { TaskDispatchRequest, TaskMethodResult } from './types.js'
import {
  validateCancelTaskParams,
  validateGetTaskParams,
  validateUpdateTaskParams
} from './validation.js'

export async function dispatchTaskRequest(
  controller: TaskController,
  request: TaskDispatchRequest
): Promise<TaskMethodResult> {
  controller.assertClientCapability(request.context.meta)

  switch (request.method) {
    case 'tasks/get': {
      const params = validateGetTaskParams(request.params)
      return controller.get(params.taskId, request.context)
    }
    case 'tasks/update': {
      const params = validateUpdateTaskParams(request.params)
      return controller.update(params.taskId, params.inputResponses, request.context)
    }
    case 'tasks/cancel': {
      const params = validateCancelTaskParams(request.params)
      return controller.cancel(params.taskId, request.context)
    }
  }
}
