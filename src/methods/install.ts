import {
  assertEventDefinition,
  type McpEventDefinition,
  type McpEventHandler,
  notifyMcpEventListChanged,
  snapshotEventDefinition
} from '../extensions/events/index.js'
import {
  assertInterceptorDefinition,
  type McpInterceptorDefinition,
  type McpInterceptorHandler
} from '../extensions/interceptors/index.js'
import {
  buildSkillDefinition,
  type McpSkillBytes,
  type McpSkillRegistrationOptions,
  snapshotSkillRegistration
} from '../extensions/skills/index.js'
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
        invalidateRegistry(this, 'tools')
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
        invalidateRegistry(this, 'resources')
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
        invalidateRegistry(this, 'prompts')
        return this
      }
    })
  }

  if (typeof target.mcpSkill !== 'function') {
    Object.defineProperty(target, 'mcpSkill', {
      configurable: true,
      enumerable: false,
      writable: true,
      value: function mcpSkill(
        this: AnyElysiaApp,
        uri: string,
        skill: McpSkillBytes,
        options: McpSkillRegistrationOptions = {}
      ) {
        const state = ensureMcpState(this)
        const registration = snapshotSkillRegistration(uri, skill, options)
        // Validate before mutating application state.
        buildSkillDefinition(registration)
        state.explicitSkills.set(uri, registration)
        invalidateRegistry(this, 'resources')
        return this
      }
    })
  }

  if (typeof target.mcpInterceptor !== 'function') {
    Object.defineProperty(target, 'mcpInterceptor', {
      configurable: true,
      enumerable: false,
      writable: true,
      value: function mcpInterceptor(
        this: AnyElysiaApp,
        definition: McpInterceptorDefinition,
        handler: McpInterceptorHandler
      ) {
        assertInterceptorDefinition(definition)
        const state = ensureMcpState(this)
        state.explicitInterceptors.set(definition.name, {
          definition: structuredClone(definition),
          handler
        })
        invalidateRegistry(this)
        return this
      }
    })
  }

  if (typeof target.mcpEvent !== 'function') {
    Object.defineProperty(target, 'mcpEvent', {
      configurable: true,
      enumerable: false,
      writable: true,
      value: function mcpEvent(
        this: AnyElysiaApp,
        definition: McpEventDefinition,
        handler: McpEventHandler
      ) {
        assertEventDefinition(definition)
        const state = ensureMcpState(this)
        state.explicitEvents.set(definition.name, {
          definition: snapshotEventDefinition(definition),
          handler
        })
        invalidateRegistry(this, 'events')
        notifyMcpEventListChanged(this)
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
  mcpSkill?: unknown
  mcpInterceptor?: unknown
  mcpEvent?: unknown
}
