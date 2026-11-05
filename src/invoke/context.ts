import { createInvocationInput } from '../transport/input.js'
import { silentNotify } from '../transport/notifications.js'
import type { McpHandlerContext, McpInvocationContext } from '../types.js'

const invocationContexts = new WeakMap<Request, McpHandlerContext>()

export function withInvocationHelpers<Context extends McpInvocationContext>(
  context: Context
): Context & McpHandlerContext {
  const { input, notify, reportProgress } = context
  if (input && notify) return context as Context & McpHandlerContext

  return {
    ...context,
    input: input ?? createInvocationInput({ modern: false, responses: context.inputResponses }),
    notify:
      notify ??
      (reportProgress ? { ...silentNotify, progress: reportProgress.bind(context) } : silentNotify)
  }
}

export function setMcpInvocationContext(request: Request, context: McpHandlerContext): void {
  invocationContexts.set(request, context)
}

export function getMcpInvocationContext(request: Request): McpHandlerContext | undefined {
  return invocationContexts.get(request)
}

export function deleteMcpInvocationContext(request: Request): boolean {
  return invocationContexts.delete(request)
}
