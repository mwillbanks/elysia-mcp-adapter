import { MCP_STATE_SYMBOL } from './constants.js'
import type { AnyElysiaApp, McpAdapterState } from './types.js'

export function ensureMcpState(app: AnyElysiaApp): McpAdapterState {
  const holder = app as unknown as { [MCP_STATE_SYMBOL]?: McpAdapterState }

  if (!holder[MCP_STATE_SYMBOL]) {
    holder[MCP_STATE_SYMBOL] = {
      explicitTools: new Map(),
      explicitResources: new Map(),
      explicitPrompts: new Map(),
      version: 0
    }
  }

  return holder[MCP_STATE_SYMBOL]
}

export function invalidateRegistry(app: AnyElysiaApp): void {
  const state = ensureMcpState(app)
  state.version += 1
  state.registryCache = undefined
}
