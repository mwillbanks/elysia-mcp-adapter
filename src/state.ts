import { MCP_STATE_SYMBOL } from './constants.js'
import type { McpEventRegistration } from './extensions/events/index.js'
import type { McpInterceptorRegistration } from './extensions/interceptors/index.js'
import type { ExplicitSkillRegistration } from './extensions/skills/index.js'
import type {
  AnyElysiaApp,
  McpAdapterState,
  McpAuthorizationOptions,
  NormalizedMcpPluginOptions
} from './types.js'

export type InitializedMcpAdapterState = McpAdapterState & {
  pluginOptions?: NormalizedMcpPluginOptions
  explicitSkills: Map<string, ExplicitSkillRegistration>
  explicitInterceptors: Map<string, McpInterceptorRegistration>
  explicitEvents: Map<string, McpEventRegistration>
}

export type McpRegistryChangeKind = 'tools' | 'resources' | 'prompts' | 'events'
type McpRegistryChangeListener = (
  kind: McpRegistryChangeKind,
  authorizationAlternatives?: readonly (McpAuthorizationOptions | undefined)[]
) => void
const REGISTRY_CHANGE_LISTENERS = new WeakMap<AnyElysiaApp, Set<McpRegistryChangeListener>>()

export function ensureMcpState(app: AnyElysiaApp): InitializedMcpAdapterState {
  const holder = app as unknown as { [MCP_STATE_SYMBOL]?: McpAdapterState }

  if (!holder[MCP_STATE_SYMBOL]) {
    holder[MCP_STATE_SYMBOL] = {
      explicitTools: new Map(),
      explicitResources: new Map(),
      explicitPrompts: new Map(),
      explicitSkills: new Map(),
      explicitInterceptors: new Map(),
      explicitEvents: new Map(),
      version: 0
    }
  }

  holder[MCP_STATE_SYMBOL].explicitSkills ??= new Map()
  holder[MCP_STATE_SYMBOL].explicitInterceptors ??= new Map()
  holder[MCP_STATE_SYMBOL].explicitEvents ??= new Map()

  return holder[MCP_STATE_SYMBOL] as InitializedMcpAdapterState
}

export function invalidateRegistry(app: AnyElysiaApp, kind?: McpRegistryChangeKind): void {
  const state = ensureMcpState(app)
  state.version += 1
  if (kind) notifyRegistryChange(app, kind)
}

export function notifyRegistryChange(
  app: AnyElysiaApp,
  kind: McpRegistryChangeKind,
  authorizationAlternatives?: readonly (McpAuthorizationOptions | undefined)[]
): void {
  for (const listener of REGISTRY_CHANGE_LISTENERS.get(app) ?? []) {
    listener(kind, authorizationAlternatives)
  }
}

export function hasRegistryChangeListeners(app: AnyElysiaApp): boolean {
  return REGISTRY_CHANGE_LISTENERS.has(app)
}

export function onRegistryChange(
  app: AnyElysiaApp,
  listener: McpRegistryChangeListener
): () => void {
  let listeners = REGISTRY_CHANGE_LISTENERS.get(app)
  if (!listeners) {
    listeners = new Set()
    REGISTRY_CHANGE_LISTENERS.set(app, listeners)
  }
  listeners.add(listener)
  return () => {
    listeners?.delete(listener)
    if (listeners?.size === 0) REGISTRY_CHANGE_LISTENERS.delete(app)
  }
}
