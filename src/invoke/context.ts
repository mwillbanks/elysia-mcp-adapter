import type { McpInvocationContext } from '../types.js'

const invocationContexts = new WeakMap<Request, McpInvocationContext>()

export function setMcpInvocationContext(request: Request, context: McpInvocationContext): void {
  invocationContexts.set(request, context)
}

export function getMcpInvocationContext(request: Request): McpInvocationContext | undefined {
  return invocationContexts.get(request)
}

export function deleteMcpInvocationContext(request: Request): boolean {
  return invocationContexts.delete(request)
}
