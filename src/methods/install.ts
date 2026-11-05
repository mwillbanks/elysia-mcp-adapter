import {
  assertEventDefinition,
  type McpEventDefinition,
  type McpEventHandler,
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
import { getMcpRegistry } from '../registry.js'
import {
  ensureMcpState,
  hasRegistryChangeListeners,
  invalidateRegistry,
  notifyRegistryChange
} from '../state.js'
import type {
  AnyElysiaApp,
  McpAuthorizationOptions,
  McpPromptDefinition,
  McpPromptHandler,
  McpPromptOptions,
  McpResourceHandler,
  McpResourceOptions,
  McpRegistry,
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
        options: McpToolOptions<any> = {}
      ) {
        const before = hasRegistryChangeListeners(this) ? readRegistrySnapshot(this) : undefined
        ensureMcpState(this).explicitTools.set(name, { name, handler, options })
        invalidateRegistry(this, 'tools')
        if (before) notifyCompanionChanges(this, before)
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
        const previous = state.explicitEvents.get(definition.name)
        const snapshot = snapshotEventDefinition(definition)
        state.explicitEvents.set(definition.name, { definition: snapshot, handler })
        invalidateRegistry(this)
        const visibleTo = previous
          ? [previous.definition.authorization, snapshot.authorization]
          : [snapshot.authorization]
        notifyRegistryChange(this, 'events', visibleTo)
        return this
      }
    })
  }

  return app
}

function readRegistrySnapshot(app: AnyElysiaApp): McpRegistry | undefined {
  try {
    return getMcpRegistry(app)
  } catch {
    // Keep registry validation on discovery when a registration is invalid.
    return undefined
  }
}

function notifyCompanionChanges(app: AnyElysiaApp, before: McpRegistry): void {
  const after = readRegistrySnapshot(app)
  if (!after) return
  const scopes = changedCompanionScopes(before, after)
  if (scopes.length > 0) notifyRegistryChange(app, 'prompts', [...new Set(scopes)])
}

function changedCompanionScopes(
  previous: McpRegistry,
  current: McpRegistry
): (McpAuthorizationOptions | undefined)[] {
  const changed: (McpAuthorizationOptions | undefined)[] = []
  for (const [registry, other] of [
    [previous, current],
    [current, previous]
  ] as const) {
    for (const [name, prompt] of registry.prompts) {
      const link = prompt.linkedToolName
      if (link && companionChanged(prompt, other.prompts.get(name))) {
        changed.push(prompt.authorization)
      } else if (link && other.tools.get(link)?.prompt !== registry.tools.get(link)?.prompt) {
        changed.push(prompt.authorization)
      }
    }
  }
  return changed
}

function companionChanged(current: McpPromptDefinition, previous?: McpPromptDefinition): boolean {
  return (
    previous?.linkedToolName !== current.linkedToolName ||
    previous?.authorization !== current.authorization ||
    previous?.source !== current.source
  )
}

interface McpMethodRuntime {
  mcpTool?: unknown
  mcpResource?: unknown
  mcpPrompt?: unknown
  mcpSkill?: unknown
  mcpInterceptor?: unknown
  mcpEvent?: unknown
}
