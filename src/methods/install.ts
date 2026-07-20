import { ensureMcpState, invalidateRegistry } from '../state.js'
import type {
  AnyElysiaApp,
  McpPromptHandler,
  McpPromptOptions,
  McpResourceHandler,
  McpResourceOptions,
  McpToolHandler,
  McpToolOptions
} from '../types.js'

export function installMcpMethods(app: AnyElysiaApp): AnyElysiaApp {
  const target = app as unknown as McpMethodRuntime

  if (typeof target.mcpTool !== 'function') {
    Object.defineProperty(target, 'mcpTool', {
      configurable: true,
      enumerable: false,
      writable: true,
      value: function mcpTool(
        this: AnyElysiaApp,
        name: string,
        handler: McpToolHandler<any>,
        options: McpToolOptions = {}
      ) {
        const state = ensureMcpState(this)
        state.explicitTools.set(name, { name, handler, options })
        invalidateRegistry(this)
        return this
      }
    })
  }

  if (typeof target.mcpResource !== 'function') {
    Object.defineProperty(target, 'mcpResource', {
      configurable: true,
      enumerable: false,
      writable: true,
      value: function mcpResource(
        this: AnyElysiaApp,
        uriOrTemplate: string,
        handler: McpResourceHandler,
        options: McpResourceOptions = {}
      ) {
        const state = ensureMcpState(this)
        state.explicitResources.set(uriOrTemplate, { uriOrTemplate, handler, options })
        invalidateRegistry(this)
        return this
      }
    })
  }

  if (typeof target.mcpPrompt !== 'function') {
    Object.defineProperty(target, 'mcpPrompt', {
      configurable: true,
      enumerable: false,
      writable: true,
      value: function mcpPrompt(
        this: AnyElysiaApp,
        name: string,
        handler: McpPromptHandler<any>,
        options: McpPromptOptions = {}
      ) {
        const state = ensureMcpState(this)
        state.explicitPrompts.set(name, { name, handler, options })
        invalidateRegistry(this)
        return this
      }
    })
  }

  return app
}

interface McpMethodRuntime {
  mcpTool?: unknown
  mcpResource?: unknown
  mcpPrompt?: unknown
}
