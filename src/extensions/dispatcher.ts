export interface McpExtensionDispatchContext {
  request: Request
  params: Record<string, unknown>
}

export type McpExtensionMethodHandler = (
  context: McpExtensionDispatchContext
) => Promise<unknown> | unknown

export interface McpExtensionDispatchResult {
  handled: boolean
  result?: unknown
}

/**
 * Internal registry for extension-owned methods. Core transport routing stays
 * independent of extension method sets and their result shapes.
 */
export class McpExtensionDispatcher {
  private readonly methods = new Map<string, McpExtensionMethodHandler>()

  register(methods: readonly string[], handler: McpExtensionMethodHandler): void {
    for (const method of methods) {
      if (this.methods.has(method)) throw new TypeError(`Duplicate MCP extension method: ${method}`)
      this.methods.set(method, handler)
    }
  }

  async dispatch(
    method: string | undefined,
    context: McpExtensionDispatchContext
  ): Promise<McpExtensionDispatchResult> {
    if (!method) return { handled: false }
    const handler = this.methods.get(method)
    if (!handler) return { handled: false }
    return { handled: true, result: await handler(context) }
  }
}
